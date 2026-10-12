/**
 * NOTE: The real container service is at src/services/containerService.js.
 *
 * This module previously contained duplicate stubs for install/run/kill.
 * Those stubs were not used by the app and could be mistaken for the
 * actual implementation. The app uses the IPC-based service in
 * src/services/containerService.js instead.
 */
export { installContainer, importFromUrl, runContainer, killContainer, resetContainer, duplicateContainer, exportContainer, getAppLogs, stopContainer, listContainers } from "../services/containerService";
