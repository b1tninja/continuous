import { Text, useStdout } from "ink";
import React from "react";

import { loopFrameTop, type LoopFrameInfo } from "./loopFrame.js";

/** The top border of the prompt box while a loop is on: corners, state icon and word. */
export const LoopFrameTop: React.FC<{ info: LoopFrameInfo }> = ({ info }) => {
  const stdout = useStdout().stdout as NodeJS.WriteStream;
  return (
    <Text color={info.color} wrap="truncate-end">
      {loopFrameTop(info, stdout.columns || 80)}
    </Text>
  );
};
