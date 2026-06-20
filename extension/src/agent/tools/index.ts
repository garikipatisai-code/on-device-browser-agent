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
  tabScreenshotTool,
  tabWaitLoadedTool,
} from './browser/tab';
import { ariaExtractTool } from './browser/aria_tool';
import { visionReadTool } from './browser/vision';
import {
  tabClickTool,
  tabScrollTool,
  tabSelectTool,
  tabTypeTool,
} from './browser/actions';
import { searchTool } from './browser/search';
import { tabUploadFileTool } from './browser/upload';

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
  r.register(searchTool);
  r.register(visionReadTool);
  // browser — act (domain-tier gated inside the tool)
  r.register(tabClickTool);
  r.register(tabTypeTool);
  r.register(tabSelectTool);
  r.register(tabScrollTool);
  r.register(tabUploadFileTool);
  return r;
}
