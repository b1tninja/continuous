package com.github.continuedev.continueintellijextension.unit

import com.github.continuedev.continueintellijextension.services.SessionIdgafService
import com.google.gson.JsonParser
import junit.framework.TestCase

class SessionIdgafServiceTest : TestCase() {
    private fun json(text: String) = JsonParser.parseString(text)

    fun `test a new session has no IDGAF areas`() {
        assertEquals(mapOf("areas" to emptyList<String>()), SessionIdgafService().handle(json("{}")))
    }

    fun `test written areas are read back in area order`() {
        val service = SessionIdgafService()
        assertEquals(
            mapOf("areas" to listOf("tools", "questions")),
            service.handle(json("""{"areas":["questions","tools"]}"""))
        )
        assertEquals(mapOf("areas" to listOf("tools", "questions")), service.handle(json("{}")))
    }

    fun `test unknown areas and non-strings are dropped`() {
        val service = SessionIdgafService()
        assertEquals(
            listOf("edits"),
            service.write(json("""["edits","everything",1,null,{"a":"tools"},["plan"]]"""))
        )
        assertEquals(listOf("edits"), service.read())
    }

    fun `test a body that is not a list clears the areas`() {
        val service = SessionIdgafService()
        service.handle(json("""{"areas":["tools"]}"""))
        assertEquals(mapOf("areas" to emptyList<String>()), service.handle(json("""{"areas":"tools"}""")))
        service.handle(json("""{"areas":["tools"]}"""))
        assertEquals(mapOf("areas" to emptyList<String>()), service.handle(json("""{"areas":null}""")))
    }

    fun `test an empty list clears the areas`() {
        val service = SessionIdgafService()
        service.handle(json("""{"areas":["tools","edits"]}"""))
        service.handle(json("""{"areas":[]}"""))
        assertEquals(emptyList<String>(), service.read())
    }

    fun `test a body without areas only reads`() {
        val service = SessionIdgafService()
        service.handle(json("""{"areas":["plan"]}"""))
        assertEquals(mapOf("areas" to listOf("plan")), service.handle(null))
        assertEquals(mapOf("areas" to listOf("plan")), service.handle(json("null")))
        assertEquals(mapOf("areas" to listOf("plan")), service.handle(json("\"areas\"")))
        assertEquals(mapOf("areas" to listOf("plan")), service.handle(json("""{"other":["tools"]}""")))
    }

    fun `test a new instance starts with nothing, like a new IDE start`() {
        SessionIdgafService().handle(json("""{"areas":["tools"]}"""))
        assertEquals(emptyList<String>(), SessionIdgafService().read())
    }
}
