import { Icon, Toast, List, showToast } from "@raycast/api";
import { ReactNode, useEffect, useState } from "react";
import { MattermostClient } from "./MattermostClient";

export function withAuthorization(children: ReactNode) {
  const [authorized, setAuthorized] = useState<boolean | Error>(false);

  useEffect(() => {
    (async () => {
      showToast(Toast.Style.Animated, "Wake up session...");
      setAuthorized(await MattermostClient.wakeUpSession());
      showToast(Toast.Style.Success, "Wake up session successfull");
    })();
  }, []);

  if (authorized !== true) {
    return (
      <List isLoading={authorized == false}>
        {authorized instanceof Error && <List.EmptyView title={authorized.message} icon={Icon.XMarkCircleFilled} />}
      </List>
    );
  }

  return children;
}
