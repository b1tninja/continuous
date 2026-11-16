## Behaviour changes

- Your message now also waits with Compact now and Continue anyway when the last request already dropped the oldest messages to fit, even if the context meter shows the conversation under the limit (the app and the server count tokens a little differently). The notice says the conversation is already past the point where the oldest turns are dropped. Nothing waits when there is nothing to compact (below 70% of the window, or with `contextManagement.plannedCompaction: false`), or after Continue anyway for the same plan.
