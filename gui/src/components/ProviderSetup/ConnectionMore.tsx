import type { ReactNode } from "react";
import { Input } from "..";
import { FormSelect } from "../../forms/FormSelect";
import {
  MORE_NOT_SET,
  MoreOptionsForm,
  timeoutProblem,
} from "./providerSetupUtils";

interface ConnectionMoreProps {
  /**
   * The API base, for a provider whose form does not ask for an address
   * itself. `notSet` is where requests go when the field is empty.
   */
  apiBase?: {
    value: string;
    onChange: (value: string) => void;
    notSet: string;
  };
  /** Bedrock: what the fields above set. Read here; changed above. */
  aws?: { region?: string; profile?: string; profileNotSet: string };
  /**
   * The name the key is stored under. `value` is empty until the person
   * types one; `inUse` is the name used then, and `why` says where it is from.
   */
  secretName?: {
    value: string;
    inUse: string;
    why: string;
    onChange: (value: string) => void;
  };
  options: MoreOptionsForm;
  onOptions: (next: MoreOptionsForm) => void;
}

/** "Set by you: X" with Reset, or "Not set: <what happens then>". */
function State({
  id,
  set,
  notSet,
  onReset,
}: {
  id: string;
  set?: string;
  notSet: string;
  onReset: () => void;
}) {
  return (
    <span
      className="mt-1 block text-xs break-words text-description-muted"
      data-testid={`more-state-${id}`}
    >
      {set ? `Set by you: ${set}` : `Not set: ${notSet}`}
      {set && (
        <button
          type="button"
          className="ml-2 inline-flex min-h-6 cursor-pointer items-center border-none bg-transparent p-0 text-xs text-link underline"
          onClick={onReset}
          aria-label={`Reset ${id}`}
        >
          Reset
        </button>
      )}
    </span>
  );
}

function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <label className="mb-1 block text-sm font-medium" htmlFor={id}>
        {label}
      </label>
      {children}
    </div>
  );
}

const onOff = (v: "" | "on" | "off") => (v === "" ? undefined : v);

/**
 * What is not needed in the first hour, folded. The header says the values
 * in use, so the state can be read without opening it. A field left alone is
 * not written anywhere.
 */
export function ConnectionMore({
  apiBase,
  aws,
  secretName,
  options,
  onOptions,
}: ConnectionMoreProps) {
  const set = <K extends keyof MoreOptionsForm>(
    key: K,
    value: MoreOptionsForm[K],
  ) => onOptions({ ...options, [key]: value });

  const paths = options.caBundlePath
    .split(/\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const summary = [
    apiBase ? `API base ${apiBase.value.trim() || apiBase.notSet}` : undefined,
    aws?.region ? `region ${aws.region}` : undefined,
    secretName ? `key name ${secretName.value || secretName.inUse}` : undefined,
    `request timeout ${options.timeout.trim() ? `${options.timeout.trim()} s` : MORE_NOT_SET.timeout}`,
    `connect timeout ${options.connectTimeout.trim() ? `${options.connectTimeout.trim()} s` : MORE_NOT_SET.connectTimeout}`,
    `proxy ${options.proxy.trim() || "from the environment"}`,
    `certificates ${(options.verifySsl || MORE_NOT_SET.verifySsl) === "off" ? "not checked" : "checked"}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <details
      className="min-w-0 rounded-sm border border-solid border-border px-2 py-1"
      data-testid="connection-more"
    >
      <summary className="cursor-pointer text-sm">
        <span className="font-medium">More</span>
        <span
          className="block text-xs break-words text-description-muted"
          data-testid="connection-more-summary"
        >
          {summary}
        </span>
      </summary>
      <div className="mt-2 flex min-w-0 flex-col gap-3 pb-1">
        {apiBase && (
          <Field id="moreApiBase" label="API base">
            <Input
              id="moreApiBase"
              className="box-border w-full"
              value={apiBase.value}
              onChange={(e) => apiBase.onChange(e.target.value)}
            />
            <State
              id="moreApiBase"
              set={apiBase.value.trim() || undefined}
              notSet={apiBase.notSet}
              onReset={() => apiBase.onChange("")}
            />
          </Field>
        )}

        {aws && (
          <div className="text-xs" data-testid="more-aws">
            <div className="text-sm font-medium">Region and profile</div>
            <div className="break-words text-description-muted">
              Region:{" "}
              {aws.region
                ? `Set by you: ${aws.region}`
                : "Not set: choose one above"}
            </div>
            <div className="break-words text-description-muted">
              AWS profile:{" "}
              {aws.profile
                ? `Set by you: ${aws.profile}`
                : `Not set: ${aws.profileNotSet}`}
            </div>
          </div>
        )}

        {secretName && (
          <Field id="secretName" label="Name the key is saved under">
            <Input
              id="secretName"
              className="box-border w-full"
              value={secretName.value}
              onChange={(e) => secretName.onChange(e.target.value)}
            />
            <State
              id="secretName"
              set={secretName.value || undefined}
              notSet={`${secretName.inUse} (${secretName.why})`}
              onReset={() => secretName.onChange("")}
            />
            <span className="mt-1 block text-xs text-description-muted">
              Every model of this provider refers to it as{" "}
              <code className="break-all">{`\${{ secrets.${secretName.value || secretName.inUse} }}`}</code>
            </span>
          </Field>
        )}

        <Field id="moreTimeout" label="Request timeout (seconds)">
          <Input
            id="moreTimeout"
            className="box-border w-full"
            inputMode="numeric"
            value={options.timeout}
            onChange={(e) => set("timeout", e.target.value)}
          />
          <State
            id="moreTimeout"
            set={options.timeout.trim() ? `${options.timeout.trim()} s` : ""}
            notSet={`${MORE_NOT_SET.timeout} for the whole reply`}
            onReset={() => set("timeout", "")}
          />
          {timeoutProblem(options.timeout) && (
            <span className="mt-1 block text-xs text-warning">
              {timeoutProblem(options.timeout)}
            </span>
          )}
        </Field>

        <Field id="moreConnectTimeout" label="Connect timeout (seconds)">
          <Input
            id="moreConnectTimeout"
            className="box-border w-full"
            inputMode="numeric"
            value={options.connectTimeout}
            onChange={(e) => set("connectTimeout", e.target.value)}
          />
          <State
            id="moreConnectTimeout"
            set={
              options.connectTimeout.trim()
                ? `${options.connectTimeout.trim()} s`
                : ""
            }
            notSet={`${MORE_NOT_SET.connectTimeout} to reach the server`}
            onReset={() => set("connectTimeout", "")}
          />
          {timeoutProblem(options.connectTimeout) && (
            <span className="mt-1 block text-xs text-warning">
              {timeoutProblem(options.connectTimeout)}
            </span>
          )}
        </Field>

        <Field id="moreProxy" label="Proxy">
          <Input
            id="moreProxy"
            className="box-border w-full"
            value={options.proxy}
            onChange={(e) => set("proxy", e.target.value)}
          />
          <State
            id="moreProxy"
            set={options.proxy.trim() || undefined}
            notSet={MORE_NOT_SET.proxy}
            onReset={() => set("proxy", "")}
          />
        </Field>

        <Field id="moreVerifySsl" label="Verify TLS certificates">
          <FormSelect
            id="moreVerifySsl"
            value={options.verifySsl}
            onChange={(e) =>
              set("verifySsl", e.target.value as MoreOptionsForm["verifySsl"])
            }
          >
            <option value="">Not set: {MORE_NOT_SET.verifySsl}</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </FormSelect>
          <State
            id="moreVerifySsl"
            set={onOff(options.verifySsl)}
            notSet={MORE_NOT_SET.verifySsl}
            onReset={() => set("verifySsl", "")}
          />
        </Field>

        <Field id="moreUseSystemCa" label="Trust the system certificate store">
          <FormSelect
            id="moreUseSystemCa"
            value={options.useSystemCa}
            onChange={(e) =>
              set(
                "useSystemCa",
                e.target.value as MoreOptionsForm["useSystemCa"],
              )
            }
          >
            <option value="">Not set: {MORE_NOT_SET.useSystemCa}</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </FormSelect>
          <State
            id="moreUseSystemCa"
            set={onOff(options.useSystemCa)}
            notSet={MORE_NOT_SET.useSystemCa}
            onReset={() => set("useSystemCa", "")}
          />
        </Field>

        <Field id="moreCaBundle" label="CA bundle files, one path per line">
          <textarea
            id="moreCaBundle"
            rows={2}
            className="box-border w-full rounded-sm border border-solid border-border bg-input p-1 font-mono text-xs text-foreground"
            value={options.caBundlePath}
            onChange={(e) => set("caBundlePath", e.target.value)}
          />
          <State
            id="moreCaBundle"
            set={paths.length > 0 ? paths.join(", ") : undefined}
            notSet={MORE_NOT_SET.caBundlePath}
            onReset={() => set("caBundlePath", "")}
          />
        </Field>
      </div>
    </details>
  );
}
