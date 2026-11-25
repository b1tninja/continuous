package com.github.continuedev.continueintellijextension.unit

import com.github.continuedev.continueintellijextension.constants.PolicyGuard
import junit.framework.TestCase

class PolicyGuardTest : TestCase() {
    fun `test an area whose level goes up is raised and one that stays or drops is not`() {
        assertEquals(
            listOf("tools"),
            PolicyGuard.raisedAreas(
                mapOf("tools" to "cautious", "edits" to "permissive", "context" to "permissive"),
                mapOf("tools" to "permissive", "edits" to "manual", "context" to "permissive")
            )
        )
    }

    fun `test delegate is higher than permissive and automatic, which are not ranked against each other`() {
        assertEquals(listOf("questions"), PolicyGuard.raisedAreas(mapOf("questions" to "permissive"), mapOf("questions" to "delegate")))
        assertEquals(listOf("questions"), PolicyGuard.raisedAreas(mapOf("questions" to "automatic"), mapOf("questions" to "delegate")))
        assertEquals(emptyList<String>(), PolicyGuard.raisedAreas(mapOf("tools" to "permissive"), mapOf("tools" to "automatic")))
        assertEquals(emptyList<String>(), PolicyGuard.raisedAreas(mapOf("tools" to "automatic"), mapOf("tools" to "permissive")))
    }

    fun `test idgaf is a preset, not a level, and delegate is a questions level only`() {
        assertFalse(PolicyGuard.savePayloadOk(mapOf("levels" to mapOf("tools" to "idgaf"))))
        assertFalse(PolicyGuard.savePayloadOk(mapOf("levels" to mapOf("tools" to "delegate"))))
        assertTrue(PolicyGuard.savePayloadOk(mapOf("levels" to mapOf("questions" to "delegate"))))
    }

    fun `test without the current levels every known level counts as raised`() {
        assertEquals(
            listOf("context", "tools"),
            PolicyGuard.raisedAreas(null, mapOf("tools" to "manual", "context" to "cautious", "plan" to "bogus"))
        )
        assertEquals(emptyList<String>(), PolicyGuard.raisedAreas(null, null))
    }

    fun `test a save body takes known areas and known levels only`() {
        assertTrue(PolicyGuard.savePayloadOk(mapOf("levels" to mapOf("tools" to "manual"))))
        assertFalse(PolicyGuard.savePayloadOk(mapOf("levels" to mapOf("tools" to "allow-all"))))
        assertFalse(PolicyGuard.savePayloadOk(mapOf("levels" to mapOf("notAnArea" to "manual"))))
        assertFalse(PolicyGuard.savePayloadOk(mapOf("levels" to null)))
        assertFalse(PolicyGuard.savePayloadOk(mapOf("levels" to listOf("manual"))))
        assertFalse(PolicyGuard.savePayloadOk(null))
        assertFalse(PolicyGuard.savePayloadOk(listOf<Any>()))
        assertTrue(PolicyGuard.savePayloadOk(mapOf("questions" to mapOf("youDecide" to listOf("scope")))))
    }

    fun `test the levels are read from a core policy load reply`() {
        val levels = mapOf("tools" to "cautious")
        val reply = mapOf("status" to "success", "content" to mapOf("settings" to mapOf("levels" to levels)), "done" to true)
        assertEquals(levels, PolicyGuard.loadedLevels(reply))
        assertNull(PolicyGuard.loadedLevels(mapOf("status" to "error", "error" to "x")))
        assertNull(PolicyGuard.loadedLevels(null))
    }
}
