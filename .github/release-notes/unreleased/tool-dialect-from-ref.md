## Fixes

- Choosing "Read it for this model" after a reply leaked a tool call now writes `toolDialect` on a model that is only a `from:` catalog reference. It used to say the config could not be edited, because the save looked for a `name` the entry does not have.
