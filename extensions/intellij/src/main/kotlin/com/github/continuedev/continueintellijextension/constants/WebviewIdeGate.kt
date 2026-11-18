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
        "policy/sessionIdgaf",
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

    fun route(messageType: String?): Route {
        if (messageType.isNullOrBlank()) return Route.REJECT
        if (messageType in DENIED_FROM_PANEL) return Route.REJECT
        if (messageType in MessageTypes.PASS_THROUGH_TO_CORE) return Route.CORE
        if (messageType in PANEL_IDE_MESSAGES) return Route.IDE
        return Route.REJECT
    }
}
