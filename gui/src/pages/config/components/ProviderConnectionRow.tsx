import type { ProviderSetupConnection } from "core/config/providerSetup";
import { Button } from "../../../components/ui";
import {
  authLabel,
  connectionLabel,
  modelCountLabel,
  providerInfoFor,
  providerTitle,
  removeConfirmText,
} from "./providerConnectionText";

export type KeyAction = { kind: "move" | "removeCopy"; secretName: string };

export interface ProviderConnectionRowProps {
  connection: ProviderSetupConnection;
  /** What can be done about where the key is kept, if anything. */
  keyAction?: KeyAction;
  confirmingKeyAction: boolean;
  confirmingRemove: boolean;
  busy: boolean;
  onManageModels: () => void;
  onEditConnection: () => void;
  onTestConnection?: () => void;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onRemove: () => void;
  onAskKeyAction: () => void;
  onCancelKeyAction: () => void;
  onKeyAction: () => void;
  onConvertToAccount: () => void;
}

const ghost = { variant: "ghost", size: "sm", className: "my-0" } as const;

function ConfirmBar(props: {
  testId: string;
  text: string;
  confirmLabel: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      role="group"
      aria-label="Confirm"
      className="flex flex-col gap-1 rounded border border-solid border-border p-2"
      data-testid={props.testId}
    >
      <span className="text-description-muted">{props.text}</span>
      <div className="flex justify-end gap-1">
        <Button {...ghost} onClick={props.onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          className="my-0"
          disabled={props.busy}
          onClick={props.onConfirm}
        >
          {props.confirmLabel}
        </Button>
      </div>
    </div>
  );
}

/**
 * One provider connection: what it is, how it signs in (names and places,
 * never a key), its models, and the ways into the setup flow.
 */
export function ProviderConnectionRow(props: ProviderConnectionRowProps) {
  const c = props.connection;
  const title = providerTitle(c);
  const where = connectionLabel(c);
  const auth = authLabel(c);
  const icon = providerInfoFor(c)?.icon;
  const action = props.keyAction;
  const firstModel = c.models[0]?.name;

  return (
    <li
      className="flex flex-col gap-1.5 border-0 border-t border-solid border-border px-3 py-2 text-xs first:border-t-0"
      data-testid={`provider-row-${c.provider}`}
      aria-label={where ? `${title}, ${where}` : title}
    >
      <div className="flex items-start gap-2">
        {window.vscMediaUrl && icon ? (
          <img
            src={`${window.vscMediaUrl}/logos/${icon}`}
            alt=""
            className="mt-0.5 h-4 w-4 shrink-0 object-contain"
          />
        ) : (
          <span className="h-4 w-4 shrink-0" aria-hidden="true" />
        )}
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium">{title}</span>
          {where && (
            <span
              className="truncate text-description-muted"
              data-testid="provider-connection"
            >
              {where}
            </span>
          )}
          <span className="text-description-muted">
            <span
              className={auth.tone === "warning" ? "text-warning" : undefined}
              data-testid="provider-auth"
            >
              {auth.text}
            </span>
            {" · "}
            <span data-testid="provider-model-count">{modelCountLabel(c)}</span>
          </span>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 pl-6">
        <Button {...ghost} onClick={props.onManageModels}>
          Manage models
        </Button>
        <Button {...ghost} onClick={props.onEditConnection}>
          Edit connection
        </Button>
        <Button
          {...ghost}
          disabled={!props.onTestConnection}
          title={
            firstModel
              ? `Opens the settings of ${firstModel} at Connection, where Test connection runs`
              : "Add a model to test this connection"
          }
          onClick={props.onTestConnection}
        >
          Test connection
        </Button>
        {action && (
          <Button {...ghost} onClick={props.onAskKeyAction}>
            {action.kind === "move"
              ? "Move key to secure storage"
              : "Remove .env copy"}
          </Button>
        )}
        {!c.account && (
          <Button
            {...ghost}
            disabled={props.busy}
            title="Save this connection as a provider account and its models in the model catalog, so other configs and cn can use them"
            onClick={props.onConvertToAccount}
            data-testid={`convert-to-account-${c.provider}`}
          >
            Turn into an account
          </Button>
        )}
        <Button {...ghost} onClick={props.onAskRemove}>
          Remove
        </Button>
      </div>

      {action && props.confirmingKeyAction && (
        <ConfirmBar
          testId="key-action-confirm"
          text={
            action.kind === "move"
              ? `Move ${action.secretName} from ~/.continuous/.env to secure storage and delete it from .env? config.yaml stays the same.`
              : `${action.secretName} is already in secure storage. Delete the plaintext line from ~/.continuous/.env?`
          }
          confirmLabel={action.kind === "move" ? "Move" : "Delete line"}
          busy={props.busy}
          onCancel={props.onCancelKeyAction}
          onConfirm={props.onKeyAction}
        />
      )}

      {props.confirmingRemove && (
        <ConfirmBar
          testId="remove-provider-confirm"
          text={removeConfirmText(c)}
          confirmLabel="Remove from config"
          busy={props.busy}
          onCancel={props.onCancelRemove}
          onConfirm={props.onRemove}
        />
      )}
    </li>
  );
}
