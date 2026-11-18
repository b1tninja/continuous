export enum BuiltInToolNames {
  ReadFile = "read_file",
  ReadFileRange = "read_file_range",
  EditExistingFile = "edit_existing_file",
  SingleFindAndReplace = "single_find_and_replace",
  MultiEdit = "multi_edit",
  ReadCurrentlyOpenFile = "read_currently_open_file",
  CreateNewFile = "create_new_file",
  RunTerminalCommand = "run_terminal_command",
  GrepSearch = "grep_search",
  FileGlobSearch = "file_glob_search",
  SearchWeb = "search_web",
  ViewDiff = "view_diff",
  LSTool = "ls",
  CreateRuleBlock = "create_rule_block",
  RequestRule = "request_rule",
  FetchUrlContent = "fetch_url_content",
  CodebaseTool = "codebase",
  ReadSkill = "read_skill",
  Subagent = "subagent",
  TaskList = "task_list",
  PresentPlan = "present_plan",
  HoldQuestion = "hold_question",
  FinishItem = "finish_item",
  RemindMe = "remind_me",
  CodeNavigation = "code_navigation",
  // Only offered when history ageing is on (CONTINUE_HISTORY_AGEING)
  RecallMaskedResult = "recall_masked_result",
  // Only offered when tool search is on (experimental.toolSearch: auto)
  SearchTools = "search_tools",
  // Only offered to subagents started together, by the gui; never in the
  // config's tool list (core/tools/definitions/sessionMessaging.ts)
  ListSessions = "list_sessions",
  SendMessage = "send_message",

  // excluded from allTools for now
  ViewRepoMap = "view_repo_map",
  ViewSubdirectory = "view_subdirectory",
}

export const BUILT_IN_GROUP_NAME = "Built-In";

export const CLIENT_TOOLS_IMPLS = [
  BuiltInToolNames.EditExistingFile,
  BuiltInToolNames.SingleFindAndReplace,
  BuiltInToolNames.MultiEdit,
  // Runs in the gui, which drives the child conversation (see
  // gui/src/util/subagents/runSubagent.ts).
  BuiltInToolNames.Subagent,
  // The task list lives in the session, which the gui holds
  BuiltInToolNames.TaskList,
  // Writes the plan file and seeds the task list, both through the gui
  BuiltInToolNames.PresentPlan,
  // Loop mode: the loop's state lives in the session, which the gui holds
  BuiltInToolNames.HoldQuestion,
  BuiltInToolNames.FinishItem,
  BuiltInToolNames.RemindMe,
];
