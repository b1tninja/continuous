package com.github.continuedev.continueintellijextension.constants

/**
 * Checks on the policy messages the panel sends, the same as the VS Code host
 * (extensions/vscode/src/extension/webviewMessageGuard.ts). The areas and
 * levels follow core/tools/permissions/policy.ts, lowest level first.
 */
object PolicyGuard {
    val POLICY_AREAS = listOf("context", "tools", "edits", "plan", "questions")
    val POLICY_LEVELS = listOf("manual", "cautious", "automatic", "permissive", "idgaf")

    /** The areas whose level goes up from [current] to [next], in area order. */
    fun raisedAreas(current: Map<*, *>?, next: Map<*, *>?): List<String> {
        if (next == null) return emptyList()
        return POLICY_AREAS.filter { area ->
            val after = rank(next[area])
            after >= 0 && after > rank(current?.get(area))
        }
    }

    /** The level's place from manual (0) to idgaf; -1 for anything else. */
    private fun rank(level: Any?): Int = if (level is String) POLICY_LEVELS.indexOf(level) else -1

    /** The panel's policy/save body: known areas and known levels only. */
    fun savePayloadOk(data: Any?): Boolean {
        if (data !is Map<*, *>) return false
        if (!data.containsKey("levels")) return true
        val levels = data["levels"] as? Map<*, *> ?: return false
        return levels.all { (area, level) -> area is String && area in POLICY_AREAS && rank(level) >= 0 }
    }

    /** The levels of a policy/save body, or none when it sets no levels. */
    fun levelsOf(data: Any?): Map<*, *>? = (data as? Map<*, *>)?.get("levels") as? Map<*, *>

    /** The levels in a core policy/load response (`{status, content: {settings: {levels}}}`). */
    fun loadedLevels(response: Any?): Map<*, *>? {
        val reply = response as? Map<*, *> ?: return null
        if (reply["status"] != "success") return null
        val settings = (reply["content"] as? Map<*, *>)?.get("settings") as? Map<*, *>
        return settings?.get("levels") as? Map<*, *>
    }
}
