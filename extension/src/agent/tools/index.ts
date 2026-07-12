// Single place that wires every tool into a registry.
import { ToolRegistry } from './registry';
import {
  echoTool,
  finishTool,
  memoryListTool,
  memoryReadTool,
  memoryWriteTool,
  nextStepTool,
} from './core';
import {
  tabCloseTool,
  tabListTool,
  tabOpenTool,
  openResultTool,
  tabReadActiveTool,
  tabScreenshotTool,
  tabWaitLoadedTool,
} from './browser/tab';
import { ariaExtractTool } from './browser/aria_tool';
import { visionReadTool, visionVerifyTool } from './browser/vision';
import {
  tabClickTool,
  tabFillManyTool,
  tabScrollTool,
  tabSelectTool,
  tabTypeTool,
} from './browser/actions';
import { searchTool } from './browser/search';
import { tabUploadFileTool } from './browser/upload';
import { workspaceAddTool, workspaceListTool, workspaceClearTool } from './workspace';
import {
  domQueryTool,
  domClickSelectorTool,
  pageWaitForTool,
  pageFetchTool,
  pageExpectTool,
  pageWaitMutationTool,
} from './browser/page';

export function buildRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  // core
  r.register(echoTool);
  r.register(nextStepTool);
  r.register(finishTool);
  r.register(memoryReadTool);
  r.register(memoryWriteTool);
  r.register(memoryListTool);
  // browser — read
  r.register(tabOpenTool);
  r.register(openResultTool);
  r.register(tabCloseTool);
  r.register(tabListTool);
  r.register(tabWaitLoadedTool);
  r.register(tabScreenshotTool);
  r.register(ariaExtractTool);
  r.register(tabReadActiveTool);
  r.register(searchTool);
  r.register(visionReadTool);
  r.register(visionVerifyTool);
  // browser — act (domain-tier gated inside the tool)
  r.register(tabClickTool);
  r.register(tabTypeTool);
  r.register(tabFillManyTool);
  r.register(tabSelectTool);
  r.register(tabScrollTool);
  r.register(tabUploadFileTool);
  // browser — page-level (DOM query, wait, fetch)
  r.register(domQueryTool);
  r.register(domClickSelectorTool);
  r.register(pageWaitForTool);
  r.register(pageFetchTool);
  r.register(pageExpectTool);
  r.register(pageWaitMutationTool);
  // workspace — cross-page structured memory
  r.register(workspaceAddTool);
  r.register(workspaceListTool);
  r.register(workspaceClearTool);
  return r;
}
