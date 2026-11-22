import { maskCommandForDisplay } from "core/tools/permissions/displayMask.js";
import { Box, Text } from "ink";
import React from "react";

import {
  askSourceText,
  truncateMiddle,
  type AskSource,
  type AskWhy,
} from "../../permissions/askWhy.js";

/** A value in a rule or a reason is hidden the same way the command above it is. */
function maskedSource(source: AskSource): AskSource {
  return {
    ...source,
    ...(source.rule ? { rule: maskCommandForDisplay(source.rule) } : {}),
  };
}

/**
 * The reason on at most about two lines; the whole of it is behind the detail
 * key. A long rule quoted in it is cut in the middle first, so the sentence
 * around it still ends.
 */
function shortReason(reason: string, width: number, rule?: string): string {
  const room = width - "Why: ".length;
  let text = reason;
  if (rule && text.length > room && text.includes(rule)) {
    const rest = text.length - rule.length;
    text = text.replace(rule, truncateMiddle(rule, Math.max(16, room - rest)));
  }
  const max = Math.max(20, Math.floor(width * 1.8));
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const RuleDetail: React.FC<{ why: AskWhy; alwaysRule?: string }> = ({
  why,
  alwaysRule,
}) => {
  const { suggestion } = why;
  if (!suggestion.ok) {
    return (
      <Text>
        <Text color="dim">No allow rule can be written for this call: </Text>
        {suggestion.reason}
      </Text>
    );
  }
  return (
    <>
      <Text>
        <Text color="dim">Narrowest allow rule for this call: </Text>
        <Text color="cyan">{maskCommandForDisplay(suggestion.rule)}</Text>
      </Text>
      <Text color="dim">
        It allows {suggestion.summary}. To use it, add it to
        toolPermissions.allow in config.yaml.
      </Text>
      {suggestion.loosensCheck && (
        <Text color="yellow">A safety check would still ask about this.</Text>
      )}
      {!why.ruleStopsAsk && (
        <Text color="yellow">
          A check asked here, not a missing rule, so this rule alone would not
          stop the ask.
        </Text>
      )}
      {alwaysRule && (
        <Text color="dim">
          Pressing a saves a different rule to permissions.yaml: {alwaysRule}
        </Text>
      )}
    </>
  );
};

interface AskWhyLinesProps {
  why: AskWhy;
  /** Columns the text may use: the prompt's width inside its border */
  width: number;
  /** The whole reason and source, and the rule that would allow the call */
  full: boolean;
  /** Never shorten the reason: it is a warning the person must be able to read */
  wholeReason?: boolean;
  /** The rule the prompt's own "always allow" saves, as it is shown there */
  alwaysRule?: string;
}

/**
 * Why the call asks and where that was decided, directly above the question.
 * Two or three lines while the person is deciding, so the command above
 * stays on screen; everything in full once they ask for it.
 */
export const AskWhyLines: React.FC<AskWhyLinesProps> = ({
  why,
  width,
  full,
  wholeReason = false,
  alwaysRule,
}) => {
  const reason = maskCommandForDisplay(why.reason);
  const source = maskedSource(why.source);
  return (
    <Box flexDirection="column">
      <Text>
        <Text color="dim">Why: </Text>
        {full || wholeReason ? reason : shortReason(reason, width, source.rule)}
      </Text>
      <Text color="dim">
        From:{" "}
        {full
          ? askSourceText(source)
          : askSourceText(source, width - "From: ".length)}
      </Text>
      {full && <RuleDetail why={why} alwaysRule={alwaysRule} />}
    </Box>
  );
};
