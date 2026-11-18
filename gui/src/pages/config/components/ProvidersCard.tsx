import type {
  ProviderSetupConnection,
  ProviderSetupInfo,
} from "core/config/providerSetup";
import { useContext, useEffect, useState } from "react";
import { useModelConfigDialog } from "../../../components/ModelConfig/useModelConfigDialog";
import { useProviderSetupDialog } from "../../../components/ProviderSetup/useProviderSetupDialog";
import { Button, Card } from "../../../components/ui";
import { IdeMessengerContext } from "../../../context/IdeMessenger";
import { useAppSelector } from "../../../redux/hooks";
import { type KeyAction, ProviderConnectionRow } from "./ProviderConnectionRow";

/** What can be done about where this connection's key is kept, if anything. */
function keyActionFor(
  c: ProviderSetupConnection,
  secureStorageAvailable: boolean,
): KeyAction | undefined {
  const { secretName, storedIn } = c.key;
  if (c.key.state !== "secret" || !secretName || !storedIn?.env) {
    return undefined;
  }
  if (!storedIn.secure) {
    return secureStorageAvailable ? { kind: "move", secretName } : undefined;
  }
  return { kind: "removeCopy", secretName };
}

const rowId = (c: ProviderSetupConnection) =>
  `${c.provider}|${c.account ?? ""}|${JSON.stringify(c.connection)}`;

type Confirming =
  | { kind: "key"; row: string; action: KeyAction }
  | { kind: "remove"; row: string };

/**
 * One row per provider connection in the selected config, with the ways back
 * into the setup flow: its models, its connection, a connection test, and
 * removing it. Shown on Settings > Providers.
 */
export function ProvidersCard() {
  const ideMessenger = useContext(IdeMessengerContext);
  const { openSetup } = useProviderSetupDialog();
  const openModelConfig = useModelConfigDialog();
  // The config object changes whenever a save reloads it.
  const config = useAppSelector((state) => state.config.config);
  const [info, setInfo] = useState<ProviderSetupInfo>();
  const [reload, setReload] = useState(0);
  // The action being confirmed, and the last failure. Never a key value.
  const [confirming, setConfirming] = useState<Confirming>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void ideMessenger
      .request("config/getProviderSetup", undefined)
      .then((res) => {
        if (!cancelled && res.status === "success") setInfo(res.content);
      })
      .catch(() => {
        // Older cores: the card stays empty.
      });
    return () => {
      cancelled = true;
    };
  }, [ideMessenger, config, reload]);

  /** Runs one change, shows its error, and reads the setup again. */
  async function run(change: () => Promise<string | undefined>) {
    setBusy(true);
    setError(undefined);
    try {
      const failure = await change();
      if (failure) setError(failure);
      setConfirming(undefined);
      setReload((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Turn a connection set up the old way into a provider account and
   * catalog models, so other configs (and cn) can use the same setup.
   */
  const convertToAccount = (c: ProviderSetupConnection) =>
    run(async () => {
      const res = await ideMessenger.request(
        "config/convertConnectionToAccount",
        { provider: c.provider, connection: c.connection },
      );
      const content = res.status === "success" ? res.content : undefined;
      return !content || content.error || content.converted === 0
        ? (content?.error ?? "Could not turn this connection into an account")
        : undefined;
    });

  const runKeyAction = (action: KeyAction) =>
    run(async () => {
      if (action.kind === "move") {
        const res = await ideMessenger.request(
          "config/moveKeyToSecureStorage",
          { secretName: action.secretName },
        );
        const content = res.status === "success" ? res.content : undefined;
        return content?.moved && !content.error
          ? undefined
          : (content?.error ?? "Could not update where the key is kept");
      }
      const res = await ideMessenger.request("config/removeEnvSecret", {
        secretName: action.secretName,
      });
      const content = res.status === "success" ? res.content : undefined;
      return content?.removed && !content.error
        ? undefined
        : (content?.error ?? "Could not update where the key is kept");
    });

  const remove = (c: ProviderSetupConnection) =>
    run(async () => {
      const res = await ideMessenger.request(
        "config/removeProviderConnection",
        {
          provider: c.provider,
          connection: c.connection,
          ...(c.account ? { account: c.account } : {}),
        },
      );
      const content = res.status === "success" ? res.content : undefined;
      if (!content || content.error) {
        return content?.error ?? "Could not remove the provider";
      }
      return content.removed.length === 0
        ? "Nothing was removed: the config has no models of this connection any more."
        : undefined;
    });

  /** Test connection opens where the palette command does: the model's settings. */
  function testConnection(c: ProviderSetupConnection) {
    const name = c.models[0]?.name;
    if (!name) return undefined;
    return () => {
      const loaded = Object.values(config.modelsByRole ?? {})
        .flat()
        .find((m) => m?.title === name);
      openModelConfig(loaded ?? { title: name });
    };
  }

  const connections = info?.connections ?? [];
  const closeConfirm = () => setConfirming(undefined);

  return (
    <Card>
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <div>
          <div className="text-sm font-medium">Connections</div>
          <div className="text-xs text-description-muted">
            Each provider connection in the selected config and how it signs in.
            Keys are never shown.
          </div>
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="my-0 shrink-0"
          onClick={() => openSetup()}
          data-testid="add-provider"
        >
          Add provider
        </Button>
      </div>
      {info && info.editable === false && (
        <div className="px-3 pb-2 text-xs text-description-muted">
          Models can only be saved to a local YAML config, and the selected
          config is not one.
        </div>
      )}
      {error && (
        <div className="px-3 pb-2 text-xs text-error" role="alert">
          {error}
        </div>
      )}
      {info && connections.length === 0 && (
        <div
          className="flex flex-col items-start gap-2 px-3 pb-3 text-xs text-description-muted"
          data-testid="providers-empty"
        >
          <span>
            No providers are set up in this config yet. Connect one to choose
            which of its models to use.
          </span>
          <Button
            size="sm"
            className="my-0"
            onClick={() => openSetup()}
            data-testid="add-provider-empty"
          >
            Add a provider
          </Button>
        </div>
      )}
      {connections.length > 0 && (
        <ul className="m-0 list-none p-0" aria-label="Provider connections">
          {connections.map((c) => {
            const id = rowId(c);
            const action = keyActionFor(
              c,
              info?.secureStorageAvailable ?? false,
            );
            const edit = {
              initialProvider: c.provider,
              initialConnection: c.connection,
            };
            return (
              <ProviderConnectionRow
                key={id}
                connection={c}
                keyAction={action}
                confirmingKeyAction={
                  confirming?.kind === "key" && confirming.row === id
                }
                confirmingRemove={
                  confirming?.kind === "remove" && confirming.row === id
                }
                busy={busy}
                onManageModels={() =>
                  openSetup({ ...edit, initialStep: "models" })
                }
                onEditConnection={() =>
                  openSetup({ ...edit, initialStep: "credentials" })
                }
                onTestConnection={testConnection(c)}
                onAskRemove={() => setConfirming({ kind: "remove", row: id })}
                onCancelRemove={closeConfirm}
                onRemove={() => void remove(c)}
                onAskKeyAction={() =>
                  action && setConfirming({ kind: "key", row: id, action })
                }
                onCancelKeyAction={closeConfirm}
                onKeyAction={() => action && void runKeyAction(action)}
                onConvertToAccount={() => void convertToAccount(c)}
              />
            );
          })}
        </ul>
      )}
    </Card>
  );
}
