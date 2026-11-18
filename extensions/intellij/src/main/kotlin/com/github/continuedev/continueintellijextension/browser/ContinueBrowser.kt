package com.github.continuedev.continueintellijextension.browser

import com.github.continuedev.continueintellijextension.constants.PolicyGuard
import com.github.continuedev.continueintellijextension.constants.WebviewIdeGate
import com.github.continuedev.continueintellijextension.services.ContinuePluginService
import com.github.continuedev.continueintellijextension.services.GsonService
import com.github.continuedev.continueintellijextension.utils.uuid
import com.intellij.ide.BrowserUtil
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.ui.jcef.*
import org.cef.CefApp
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefLoadHandlerAdapter
import org.cef.handler.CefRequestHandlerAdapter
import org.cef.network.CefRequest
import java.util.Base64
import javax.swing.JComponent

class ContinueBrowser(
    private val project: Project,
    private val gsonService: GsonService = service<GsonService>(),
): Disposable {

    private val log = Logger.getInstance(ContinueBrowser::class.java.simpleName)
    private val browser: JBCefBrowser = JBCefBrowser.createBuilder().setOffScreenRendering(true).build()
    private val myJSQueryOpenInBrowser = JBCefJSQuery.create(browser as JBCefBrowserBase)

    init {
        CefApp.getInstance().registerSchemeHandlerFactory("http", "continue", CustomSchemeHandlerFactory())
        browser.jbCefClient.setProperty(JBCefClient.Properties.JS_QUERY_POOL_SIZE, 200)
        myJSQueryOpenInBrowser.addHandler { msg: String? ->
            val json = gsonService.gson.fromJson(msg, BrowserMessage::class.java)
            val messageType = json.messageType
            val data = json.data
            val messageId = json.messageId

            when (WebviewIdeGate.route(messageType)) {
                WebviewIdeGate.Route.CORE -> {
                    val forward = {
                        project.service<ContinuePluginService>().coreMessenger?.request(messageType, data, messageId) { response ->
                            sendToWebview(messageType, response, messageId ?: uuid())
                        }
                    }
                    // Core asks in the IDE's own notification before a save that
                    // loosens (core/tools/permissions/policySave.ts); here only
                    // the shape is checked, as in VS Code
                    if ((messageType == "policy/save" || messageType == "policy/preview") &&
                        !PolicyGuard.savePayloadOk(data)
                    ) {
                        sendError(messageType, "That is not a permission settings change.", messageId)
                    } else {
                        forward()
                    }
                }

                WebviewIdeGate.Route.IDE -> {
                    if (msg != null) {
                        project.service<ContinuePluginService>().ideProtocolClient?.handleMessage(msg) { response ->
                            sendToWebview(
                                messageType,
                                mapOf(
                                    "status" to "success",
                                    "content" to response,
                                    "done" to true
                                ),
                                messageId ?: uuid()
                            )
                        }
                    }
                }

                WebviewIdeGate.Route.REJECT -> {
                    log.warn("Rejected panel message: $messageType")
                    sendError(messageType ?: "", "This message is not available to the panel", messageId)
                }
            }

            null
        }

        browser.jbCefClient.addLoadHandler(OnPageLoad { frameUrl ->
            if (ContinueBrowserSecurity.shouldInjectBridge(frameUrl, getGuiUrl())) {
                executeJavaScript(myJSQueryOpenInBrowser)
            }
        }, browser.cefBrowser)

        browser.jbCefClient.addRequestHandler(object : CefRequestHandlerAdapter() {
            override fun onBeforeBrowse(
                browser: CefBrowser?,
                frame: CefFrame?,
                request: CefRequest?,
                userGesture: Boolean,
                isRedirect: Boolean,
            ): Boolean {
                val decision = ContinueBrowserSecurity.navigation(request?.url, getGuiUrl())
                if (decision == ContinueBrowserSecurity.Navigation.OPEN_EXTERNAL) {
                    request?.url?.let { BrowserUtil.browse(it) }
                }
                return decision != ContinueBrowserSecurity.Navigation.ALLOW
            }
        }, browser.cefBrowser)

        // Load the url only after the protocolClient is initialized,
        // otherwise some messages will be lost, which are some configurations when the page is loaded.
        // Moreover, we should add LoadHandler before loading the url.
        project.service<ContinuePluginService>().onProtocolClientInitialized {
            browser.loadURL(getGuiUrl())
        }

        browser.createImmediately()
    }

    fun getComponent(): JComponent =
        browser.component

    fun focusOnInput() {
        browser.component.components?.get(0)?.requestFocus()
    }

    fun openDevTools() {
        browser.openDevtools()
    }

    private fun sendError(messageType: String, error: String, messageId: String?) {
        sendToWebview(
            messageType,
            mapOf("status" to "error", "error" to error, "done" to true),
            messageId ?: uuid()
        )
    }

    fun sendToWebview(messageType: String, data: Any? = null, messageId: String = uuid()) {
        if (browser.cefBrowser.isClosed) {
            log.warn("Attempted to send message to disposed browser: $messageType")
            return
        }
        val json = gsonService.gson.toJson(BrowserMessage(messageType, messageId, data))
        try {
            if (json.length <= CHUNKED_MESSAGE_THRESHOLD) {
                browser.cefBrowser.executeJavaScript(
                    ContinueBrowserSecurity.postMessageScript(json, getGuiUrl()),
                    getGuiUrl(),
                    0,
                )
            } else {
                sendChunked(json, messageId)
            }
        } catch (error: Exception) {
            log.warn(error)
        }
    }

    // Base64-encode and send in 512KB chunks to avoid JCEF freezing on large JS source strings
    private fun sendChunked(json: String, bufferId: String) {
        val origin = ContinueBrowserSecurity.originOf(getGuiUrl()) ?: "http://continue"
        val scripts = buildChunkScripts(json, bufferId, targetOrigin = origin)
        val url = getGuiUrl()

        browser.cefBrowser.executeJavaScript(scripts.init, url, 0)

        try {
            for (chunkScript in scripts.chunks) {
                browser.cefBrowser.executeJavaScript(chunkScript, url, 0)
            }
            browser.cefBrowser.executeJavaScript(scripts.finalize, url, 0)
        } catch (e: Exception) {
            try {
                browser.cefBrowser.executeJavaScript(scripts.cleanup, url, 0)
            } catch (_: Exception) {}
            throw e
        }
    }

    private fun executeJavaScript(myJSQueryOpenInBrowser: JBCefJSQuery) {
        val script = """
            window.postIntellijMessage = function(messageType, data, messageId) {
                const msg = JSON.stringify({messageType, data, messageId});
                ${myJSQueryOpenInBrowser.inject("msg")}
            }
            """
        browser.cefBrowser.executeJavaScript(script, getGuiUrl(), 0)
    }

    override fun dispose() {
        Disposer.dispose(myJSQueryOpenInBrowser)
        Disposer.dispose(browser)
    }

    // todo: remove and use types.Message
    private data class BrowserMessage(
        val messageType: String,
        val messageId: String?,
        val data: Any?
    )

    private class OnPageLoad(
        private val onLoad: (url: String?) -> Unit
    ) : CefLoadHandlerAdapter() {
        override fun onLoadingStateChange(
            browser: CefBrowser?,
            isLoading: Boolean,
            canGoBack: Boolean,
            canGoForward: Boolean
        ) {
            if (!isLoading)
                onLoad(browser?.url)
        }
    }

    internal data class ChunkScripts(
        val init: String,
        val chunks: List<String>,
        val finalize: String,
        val cleanup: String,
    )

    internal companion object {
        internal const val CHUNKED_MESSAGE_THRESHOLD = 1 * 1024 * 1024 // 1MB
        internal const val CHUNK_SIZE = 2 * 1024 * 1024 // 2MB

        private fun getGuiUrl() =
            System.getenv("GUI_URL") ?: "http://continue/index.html"

        internal fun buildChunkScripts(
            json: String,
            bufferId: String,
            chunkSize: Int = CHUNK_SIZE,
            targetOrigin: String = "http://continue",
        ): ChunkScripts {
            val encoded = Base64.getEncoder().encodeToString(json.toByteArray(Charsets.UTF_8))
            val chunks = mutableListOf<String>()

            var offset = 0
            while (offset < encoded.length) {
                val end = minOf(offset + chunkSize, encoded.length)
                val chunk = encoded.substring(offset, end)
                chunks.add("""window.__cc["$bufferId"].push("$chunk");""")
                offset = end
            }

            return ChunkScripts(
                init = """window.__cc=window.__cc||{};window.__cc["$bufferId"]=[];""",
                chunks = chunks,
                finalize = """try{var b=atob(window.__cc["$bufferId"].join(""));window.postMessage(JSON.parse(new TextDecoder().decode(Uint8Array.from(b,function(c){return c.charCodeAt(0)}))),${ContinueBrowserSecurity.jsString(targetOrigin)})}
finally{delete window.__cc["$bufferId"]}""",
                cleanup = """delete window.__cc["$bufferId"];""",
            )
        }
    }

}