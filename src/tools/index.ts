import { accountTools } from "./account";
import { adminRolesTools } from "./admin-roles";
import { adminSettingsTools } from "./admin-settings";
import { adminUsersTools } from "./admin-users";
import { artifactsTools } from "./artifacts";
import { captureTools } from "./capture";
import { collectionsTools } from "./collections";
import { credentialsTools } from "./credentials";
import { entriesTools } from "./entries";
import { jobsTools } from "./jobs";
import { maintenanceTools } from "./maintenance";
import { metaTools } from "./meta";
import { assertUniqueNames, type ToolDef, type ToolModule } from "./registry";
import { summariesTools } from "./summaries";
import { tagsTools } from "./tags";

/**
 * Every tool module, one file each. Adding a tool means editing only its module; this
 * list is fixed. Module order is the order tools are listed to clients.
 */
export const toolModules: Readonly<Record<string, ToolModule>> = {
  meta: metaTools,
  entries: entriesTools,
  artifacts: artifactsTools,
  capture: captureTools,
  jobs: jobsTools,
  summaries: summariesTools,
  tags: tagsTools,
  collections: collectionsTools,
  account: accountTools,
  "admin-users": adminUsersTools,
  "admin-roles": adminRolesTools,
  "admin-settings": adminSettingsTools,
  maintenance: maintenanceTools,
  credentials: credentialsTools,
};

/** All tool definitions from all modules (unfiltered), with unique names enforced. */
export function allTools(modules: Readonly<Record<string, ToolModule>> = toolModules): ToolDef[] {
  const tools = Object.values(modules).flatMap((module) => module());
  assertUniqueNames(tools);
  return tools;
}
