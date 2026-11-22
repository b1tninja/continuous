import { useContext, useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../../context/Auth";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useAppSelector } from "../../redux/hooks";
import { CONFIG_ROUTES } from "../../util/navigation";
import Alert from "../gui/Alert";

export const FatalErrorIndicator = () => {
  const { refreshProfiles } = useAuth();
  const configError = useAppSelector((store) => store.config.configError);
  const ideMessenger = useContext(IdeMessengerContext);
  const location = useLocation();
  const navigate = useNavigate();

  const hasFatalErrors = useMemo(() => {
    return configError?.some((error) => error.fatal);
  }, [configError]);

  const configLoading = useAppSelector((state) => state.config.loading);
  const showConfigPage = () => {
    navigate(CONFIG_ROUTES.CONFIGS);
  };
  const currentPath = `${location.pathname}${location.search}`;

  const { selectedProfile } = useAuth();
  // Buttons that look like the links they replace: the alert's own font and
  // colour, no box
  const linkButton =
    "cursor-pointer border-none bg-transparent p-0 [font:inherit] text-inherit underline";

  if (!hasFatalErrors) {
    return null;
  }

  const displayName = selectedProfile
    ? (selectedProfile.title ??
      `${selectedProfile.fullSlug?.ownerSlug}/${selectedProfile.fullSlug?.packageSlug}`)
    : "config";

  return (
    <Alert type="error" className="mx-2 my-1 px-2">
      <span>{`Error loading`}</span>{" "}
      <span className="italic">{displayName}</span>
      {". "}
      <span>{`Chat is disabled until a model is available.`}</span>
      <div className="mt-2 flex flex-row flex-wrap items-center gap-x-3 gap-y-1.5">
        <button
          type="button"
          onClick={() => {
            ideMessenger.post(
              "openUrl",
              "https://b1tninja.github.io/continuous/troubleshooting",
            );
          }}
          className={linkButton}
        >
          Help
        </button>
        {configLoading ? (
          <div>Reloading...</div>
        ) : (
          <button
            type="button"
            className={linkButton}
            onClick={() => {
              refreshProfiles("Clicked reload in fatal indicator");
            }}
          >
            Reload
          </button>
        )}
        {currentPath !== CONFIG_ROUTES.CONFIGS && (
          <button type="button" onClick={showConfigPage} className={linkButton}>
            View
          </button>
        )}
      </div>
    </Alert>
  );
};
