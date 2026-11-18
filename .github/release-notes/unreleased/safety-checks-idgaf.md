## New

- A shield beside the session controls turns safety checks on or off, and lists each built-in check so one of them can be switched on its own. The choice is saved in `permissions.yaml` as `safetyChecks: on` or `safetyChecks: off`. Leave it unset and the checks stay on, and stay off at IDGAF.
- A blocked call in Recently blocked has **Disable this rule** when that block came from one of those checks.

## Behaviour changes

- At IDGAF, safety checks stay off until you turn them on. A secret read followed by a network call, a push or a publish runs at IDGAF, where it used to be the one call IDGAF refused. Turn the shield on and that call is refused again, and is never asked. With safety checks off, or with `protect-secrets` off, it runs at the other levels too. A web fetch keeps its own hard checks, and the policy files stay locked.
