package com.github.continuedev.continueintellijextension.unit

import com.github.continuedev.continueintellijextension.constants.WebviewIdeGate
import junit.framework.TestCase

class WebviewIdeGateTest : TestCase() {
    fun `test readSecrets never reaches an IDE handler`() {
        assertEquals(WebviewIdeGate.Route.REJECT, WebviewIdeGate.route("readSecrets"))
        assertEquals(WebviewIdeGate.Route.REJECT, WebviewIdeGate.route("writeSecrets"))
    }

    fun `test subprocess is not answered from the panel`() {
        assertEquals(WebviewIdeGate.Route.REJECT, WebviewIdeGate.route("subprocess"))
    }

    fun `test unknown messages are rejected`() {
        assertEquals(WebviewIdeGate.Route.REJECT, WebviewIdeGate.route("not-a-message"))
        assertEquals(WebviewIdeGate.Route.REJECT, WebviewIdeGate.route(null))
        assertEquals(WebviewIdeGate.Route.REJECT, WebviewIdeGate.route(""))
    }

    fun `test core pass-through stays on the core route`() {
        assertEquals(WebviewIdeGate.Route.CORE, WebviewIdeGate.route("llm/streamChat"))
        assertEquals(WebviewIdeGate.Route.CORE, WebviewIdeGate.route("tools/evaluatePolicy"))
        assertEquals(WebviewIdeGate.Route.CORE, WebviewIdeGate.route("policy/load"))
        assertEquals(WebviewIdeGate.Route.CORE, WebviewIdeGate.route("policy/save"))
    }

    fun `test policy settings reach core, which confirms a loosening save itself`() {
        assertEquals(WebviewIdeGate.Route.CORE, WebviewIdeGate.route("policy/load"))
        assertEquals(WebviewIdeGate.Route.CORE, WebviewIdeGate.route("policy/save"))
        assertEquals(WebviewIdeGate.Route.CORE, WebviewIdeGate.route("policy/preview"))
    }

    fun `test panel file and terminal messages stay allowed`() {
        assertEquals(WebviewIdeGate.Route.IDE, WebviewIdeGate.route("writeFile"))
        assertEquals(WebviewIdeGate.Route.IDE, WebviewIdeGate.route("runCommand"))
        assertEquals(WebviewIdeGate.Route.IDE, WebviewIdeGate.route("openUrl"))
        assertEquals(WebviewIdeGate.Route.IDE, WebviewIdeGate.route("readFile"))
        assertEquals(WebviewIdeGate.Route.IDE, WebviewIdeGate.route("policy/sessionIdgaf"))
    }

    fun `test denied types are not also allowed`() {
        for (type in WebviewIdeGate.DENIED_FROM_PANEL) {
            assertFalse(WebviewIdeGate.PANEL_IDE_MESSAGES.contains(type))
            assertEquals(WebviewIdeGate.Route.REJECT, WebviewIdeGate.route(type))
        }
    }
}
