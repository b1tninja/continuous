package com.github.continuedev.continueintellijextension.constants

/**
 * Which messages from the panel may reach an IDE handler.
 * Core talks to [com.github.continuedev.continueintellijextension.continue.IdeProtocolClient]
 * on its own channel and is not limited by this gate. The panel never receives
 * stored secrets.
 */
object WebviewIdeGate {
    enum class Route { CORE, IDE, REJECT }

    val DENIED_FROM_PANEL = setOf(
        "readSecrets",
        "writeSecrets",
        "subprocess",
    )

    /**
     * Handlers the panel uses (plans, the terminal button, files in the
     * workspace, navigation). Secrets and process execution are not here.
     */
    val PANEL_IDE_MESSAGES = setOf(
        "toggleDevTools",
        "showTutorial",
        "jetbrains/isOSREnabled",
        "jetbrains/getColors",
        "jetbrains/onLoad",
        "showFile",
        "getIdeSettings",
        "getControlPlaneSessionInfo",
        "logoutOfControlPlane",
        "getIdeInfo",
        "getUniqueId",
        "copyText",
        "showDiff",
        "readFile",
        "readRangeInFile",
        "getWorkspaceDirs",
        "getTags",
        "getTerminalContents",
        "isWorkspaceRemote",
        "saveFile",
        "showVirtualFile",
        "showLines",
        "getFileStats",
        "listDir",
        "getGitRootPath",
        "getBranch",
        "getRepoName",
        "getDiff",
        "getProblems",
        "writeFile",
        "fileExists",
        "openFile",
        "runCommand",
        "showToast",
        "closeSidebar",
        "getSearchResults",
        "getFileResults",
        "getOpenFiles",
        "getCurrentFile",
        "getPinnedFiles",
        "openUrl",
        "insertAtCursor",
        "acceptDiff",
        "rejectDiff",
        "applyToFile",
    )

    /** As core/util/typedCommand.ts: MAX_TYPED_COMMAND_CHARS */
    const val MAX_TYPED_COMMAND_CHARS = 8_000

    // Line and paragraph separators, and direction marks: with these the
    // person would read a command other than the one Enter runs
    private val DIRECTION_MARKS =
        setOf('\u061C', '\u200E', '\u200F', '\u2028', '\u2029') + ('\u202A'..'\u202E') + ('\u2066'..'\u2069')

    /**
     * Why the panel's runCommand text is not typed into the terminal, or null
     * when it may be. The text is typed and Enter is left to the person, which
     * holds only for one line of plain text: a line break runs what is before
     * it, and any other control character reaches the shell as a key press.
     * The same check as core/util/typedCommand.ts (typedCommandRefusal).
     */
    fun typedCommandRefusal(data: Any?): String? {
        val command = (data as? Map<*, *>)?.get("command") as? String
        if (command.isNullOrBlank()) return "there is no command"
        if (command.length > MAX_TYPED_COMMAND_CHARS) {
            return "it is longer than $MAX_TYPED_COMMAND_CHARS characters"
        }
        if (command.any { it.isISOControl() || it in DIRECTION_MARKS }) {
            return "it has a line break or a control character"
        }
        return null
    }

    fun route(messageType: String?): Route {
        if (messageType.isNullOrBlank()) return Route.REJECT
        if (messageType in DENIED_FROM_PANEL) return Route.REJECT
        if (messageType in MessageTypes.PASS_THROUGH_TO_CORE) return Route.CORE
        if (messageType in PANEL_IDE_MESSAGES) return Route.IDE
        return Route.REJECT
    }
}
