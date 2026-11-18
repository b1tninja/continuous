package com.github.continuedev.continueintellijextension.services

import com.github.continuedev.continueintellijextension.constants.PolicyGuard
import com.google.gson.JsonElement
import com.intellij.openapi.components.Service

/**
 * The areas the person set to IDGAF in this project window, for as long as
 * the IDE runs. permissions.yaml never stores IDGAF, so the panel reads its
 * levels from that file on every load; without this, reloading the panel in
 * the middle of an unattended run dropped IDGAF and the run went back to
 * asking.
 *
 * It is kept in memory only and never written to disk, so closing the project
 * or starting the IDE again starts at the saved, non-IDGAF levels. This is the
 * JetBrains side of `policy/sessionIdgaf`; VS Code keeps the same areas under
 * its session id (extensions/vscode/src/util/sessionIdgaf.ts).
 */
@Service(Service.Level.PROJECT)
class SessionIdgafService {
    private var areas: List<String> = emptyList()

    /** The areas at IDGAF now. */
    @Synchronized
    fun read(): List<String> = areas

    /** Remembers the areas at IDGAF; unknown areas are dropped, none clears them. */
    @Synchronized
    fun write(value: JsonElement?): List<String> {
        areas = areasOf(value)
        return areas
    }

    /**
     * Answers `policy/sessionIdgaf`: a body with `areas` sets them, any other
     * body reads them. The reply is always `{ areas }`.
     */
    fun handle(data: JsonElement?): Map<String, List<String>> {
        val given = if (data != null && data.isJsonObject && data.asJsonObject.has("areas")) {
            write(data.asJsonObject.get("areas"))
        } else {
            read()
        }
        return mapOf("areas" to given)
    }

    companion object {
        /** The known areas named in [value], in area order; none unless it is a list. */
        fun areasOf(value: JsonElement?): List<String> {
            if (value == null || !value.isJsonArray) return emptyList()
            val named = value.asJsonArray
                .filter { it.isJsonPrimitive && it.asJsonPrimitive.isString }
                .map { it.asString }
                .toSet()
            return PolicyGuard.POLICY_AREAS.filter { it in named }
        }
    }
}
