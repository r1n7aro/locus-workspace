<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { CanvasView, UnityReferenceChip, unity, useUnityAssetDropTarget, view } from "@locus/view-runtime";

declare global {
  interface Window {
    __locusWorkspaceClear?: () => Promise<void>;
  }
}

type UnityRefKind = "asset" | "sceneObject" | "knowledge";

interface UnityReference {
  path: string;
  kind: UnityRefKind;
  name?: string;
  typeLabel?: string;
  source?: "unity" | "manual";
}

interface AssetSearchResult {
  path: string;
  name: string;
  kind?: string;
  typeLabel?: string;
}

interface AssetBlock {
  id: string;
  kind: UnityRefKind;
  path: string;
  name: string;
  typeLabel: string;
  source: "unity" | "manual";
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WorkspacePage {
  id: string;
  name: string;
  blocks: AssetBlock[];
}

interface WorkspaceStorage {
  version: 1;
  activePageId: string;
  pages: WorkspacePage[];
}

const STORAGE_KEY = "locus-workspace.pages.v1";
const DEFAULT_BLOCK_WIDTH = 300;
const DEFAULT_BLOCK_HEIGHT = 126;
const canvasBehavior = {
  readonly: false,
  allowCreate: false,
  allowDelete: true,
  allowCopy: true,
  allowPaste: true,
  allowMove: true,
  allowSelect: true,
  allowBoxSelect: true,
  allowContextMenu: true,
};

const canvasRef = ref<any>(null);
const canvasHostRef = ref<HTMLElement | null>(null);
const mainRef = ref<HTMLElement | null>(null);
const searchInputRef = ref<HTMLInputElement | null>(null);
const selectedBlockIds = ref<string[]>([]);
const clipboard = ref<AssetBlock[]>([]);
const dirty = ref(false);
const statusText = ref("Ready");
const searchQuery = ref("");
const searchResults = ref<AssetSearchResult[]>([]);
const searchStatus = ref("Type to search assets");
const searchLoading = ref(false);
const searchMenu = ref({ open: false, x: 16, y: 52, anchorX: 120, anchorY: 120 });
const lastDropWorldPoint = ref({ x: 120, y: 120 });
let idSequence = 0;
let saveTimer = 0;
let searchTimer = 0;
let searchRequestId = 0;
const pages = ref<WorkspacePage[]>([createPage("Page 1")]);
const activePageId = ref(pages.value[0].id);

const assetDrop = useUnityAssetDropTarget({
  onDrop: (refs: UnityReference[]) => addReferences(refs, lastDropWorldPoint.value),
});

const assetDropActive = computed(() => assetDrop.active.value && assetDrop.refs.value.length > 0);
const activePage = computed(() => pages.value.find((page) => page.id === activePageId.value) ?? pages.value[0]);
const activeBlocks = computed(() => activePage.value?.blocks ?? []);
const selectedBlock = computed(() => activeBlocks.value.find((block) => block.id === selectedBlockIds.value[0]) ?? null);
const activePageName = computed({
  get: () => activePage.value?.name ?? "",
  set: (value: string) => {
    if (!activePage.value) return;
    activePage.value.name = value;
    markDirty();
  },
});
const searchPanelStyle = computed(() => ({
  left: `${searchMenu.value.x}px`,
  top: `${searchMenu.value.y}px`,
}));

onMounted(() => {
  window.__locusWorkspaceClear = clearWorkspaceData;
  void loadWorkspace();
});

onBeforeUnmount(() => {
  if (window.__locusWorkspaceClear === clearWorkspaceData) {
    delete window.__locusWorkspaceClear;
  }
  if (saveTimer) window.clearTimeout(saveTimer);
  if (searchTimer) window.clearTimeout(searchTimer);
});

function createId(prefix: string) {
  idSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${idSequence}`;
}

function createPage(name: string): WorkspacePage {
  return {
    id: createId("page"),
    name,
    blocks: [],
  };
}

function basenameWithoutExtension(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/g, "");
  const file = normalized.split("/").filter(Boolean).pop() || normalized;
  const dotIndex = file.lastIndexOf(".");
  return dotIndex > 0 ? file.slice(0, dotIndex) : file;
}

function normalizeKind(kind?: string): UnityRefKind {
  return kind === "sceneObject" || kind === "knowledge" ? kind : "asset";
}

function blockReference(block: AssetBlock): UnityReference {
  return {
    kind: block.kind,
    path: block.path,
    name: block.name,
    typeLabel: block.typeLabel,
    source: block.source,
  };
}

function blockClass(block: AssetBlock, selected: boolean) {
  return [
    "asset-block",
    selected ? "selected" : "",
    block.kind === "sceneObject" ? "scene-object" : "",
  ];
}

function normalizeStoredBlock(input: any): AssetBlock | null {
  if (!input || typeof input.path !== "string" || !input.path.trim()) return null;
  return {
    id: typeof input.id === "string" && input.id ? input.id : createId("asset"),
    kind: normalizeKind(input.kind),
    path: input.path.trim().replace(/\\/g, "/"),
    name: typeof input.name === "string" && input.name.trim() ? input.name.trim() : basenameWithoutExtension(input.path),
    typeLabel: typeof input.typeLabel === "string" ? input.typeLabel : "Asset",
    source: input.source === "unity" ? "unity" : "manual",
    x: Number.isFinite(input.x) ? input.x : 120,
    y: Number.isFinite(input.y) ? input.y : 120,
    width: Number.isFinite(input.width) ? input.width : DEFAULT_BLOCK_WIDTH,
    height: Number.isFinite(input.height) ? input.height : DEFAULT_BLOCK_HEIGHT,
  };
}

function normalizeStoredPage(input: any, index: number): WorkspacePage | null {
  if (!input || !Array.isArray(input.blocks)) return null;
  const blocks = input.blocks
    .map((block: any) => normalizeStoredBlock(block))
    .filter((block: AssetBlock | null): block is AssetBlock => !!block);
  return {
    id: typeof input.id === "string" && input.id ? input.id : createId("page"),
    name: typeof input.name === "string" && input.name.trim() ? input.name.trim() : `Page ${index + 1}`,
    blocks,
  };
}

async function loadWorkspace() {
  statusText.value = "Loading";
  try {
    const stored = await view.storage.get(STORAGE_KEY) as WorkspaceStorage | null;
    if (stored && Array.isArray(stored.pages)) {
      const normalized = stored.pages
        .map((page, index) => normalizeStoredPage(page, index))
        .filter((page: WorkspacePage | null): page is WorkspacePage => !!page);
      if (normalized.length) {
        pages.value = normalized;
        activePageId.value = normalized.some((page) => page.id === stored.activePageId)
          ? stored.activePageId
          : normalized[0].id;
      }
    }
    statusText.value = "Ready";
    dirty.value = false;
  } catch (error) {
    statusText.value = error instanceof Error ? error.message : String(error);
  }
}

function snapshotWorkspace(): WorkspaceStorage {
  return {
    version: 1,
    activePageId: activePageId.value,
    pages: pages.value.map((page) => ({
      id: page.id,
      name: page.name,
      blocks: page.blocks.map((block) => ({ ...block })),
    })),
  };
}

async function saveWorkspace() {
  if (saveTimer) {
    window.clearTimeout(saveTimer);
    saveTimer = 0;
  }
  statusText.value = "Saving";
  try {
    await view.storage.set(STORAGE_KEY, snapshotWorkspace());
    dirty.value = false;
    statusText.value = "Saved";
  } catch (error) {
    statusText.value = error instanceof Error ? error.message : String(error);
  }
}

function scheduleSave() {
  if (saveTimer) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = 0;
    void saveWorkspace();
  }, 350);
}

function markDirty() {
  dirty.value = true;
  statusText.value = "Modified";
  scheduleSave();
}

function activatePage(pageId: string) {
  if (activePageId.value === pageId) return;
  activePageId.value = pageId;
  selectedBlockIds.value = [];
  markDirty();
}

function addPage() {
  const page = createPage(`Page ${pages.value.length + 1}`);
  pages.value.push(page);
  activePageId.value = page.id;
  selectedBlockIds.value = [];
  markDirty();
}

function deleteActivePage() {
  if (pages.value.length <= 1 || !activePage.value) return;
  const index = pages.value.findIndex((page) => page.id === activePage.value.id);
  pages.value.splice(index, 1);
  activePageId.value = pages.value[Math.max(0, index - 1)].id;
  selectedBlockIds.value = [];
  markDirty();
}

function normalizeActivePageName() {
  if (!activePage.value) return;
  const nextName = activePage.value.name.trim() || "Untitled";
  if (nextName === activePage.value.name) return;
  activePage.value.name = nextName;
  markDirty();
}

function blurEventTarget(event: Event) {
  if (event.target instanceof HTMLElement) event.target.blur();
}

function pointFromClient(clientX: number, clientY: number) {
  const host = canvasHostRef.value;
  const viewport = canvasRef.value?.viewport ?? { x: 24, y: 24, scale: 1 };
  if (!host) return { x: 120, y: 120 };
  const rect = host.getBoundingClientRect();
  return {
    x: Math.round((clientX - rect.left - viewport.x) / viewport.scale),
    y: Math.round((clientY - rect.top - viewport.y) / viewport.scale),
  };
}

function menuPointFromClient(clientX: number, clientY: number) {
  const rect = mainRef.value?.getBoundingClientRect();
  if (!rect) return { x: 16, y: 52 };
  const maxX = Math.max(8, rect.width - 356);
  const maxY = Math.max(8, rect.height - 310);
  return {
    x: Math.min(maxX, Math.max(8, Math.round(clientX - rect.left + 2))),
    y: Math.min(maxY, Math.max(8, Math.round(clientY - rect.top + 2))),
  };
}

function onCanvasDragenter(event: DragEvent) {
  lastDropWorldPoint.value = pointFromClient(event.clientX, event.clientY);
  assetDrop.dragenter(event);
}

function onCanvasDragover(event: DragEvent) {
  lastDropWorldPoint.value = pointFromClient(event.clientX, event.clientY);
  assetDrop.dragover(event);
}

function onCanvasDrop(event: DragEvent) {
  lastDropWorldPoint.value = pointFromClient(event.clientX, event.clientY);
  assetDrop.drop(event);
}

function openSearchAt(clientX: number, clientY: number, anchor: { x: number; y: number }) {
  const menu = menuPointFromClient(clientX, clientY);
  searchMenu.value = {
    open: true,
    x: menu.x,
    y: menu.y,
    anchorX: anchor.x,
    anchorY: anchor.y,
  };
  searchQuery.value = "";
  searchResults.value = [];
  searchStatus.value = "Type to search assets";
  nextTick(() => searchInputRef.value?.focus());
}

function openToolbarSearch() {
  const host = canvasHostRef.value;
  if (!host) {
    openSearchAt(24, 64, { x: 120, y: 120 });
    return;
  }
  const rect = host.getBoundingClientRect();
  openSearchAt(rect.left + 48, rect.top + 48, pointFromClient(rect.left + 120, rect.top + 120));
}

function onCanvasContextMenu(event: { itemId?: string; x: number; y: number; clientX: number; clientY: number }) {
  if (event.itemId) return;
  openSearchAt(event.clientX, event.clientY, { x: event.x, y: event.y });
}

function onCanvasClick() {
  if (searchMenu.value.open) closeSearch();
}

function closeSearch() {
  searchMenu.value.open = false;
}

function scheduleSearch() {
  if (searchTimer) window.clearTimeout(searchTimer);
  const query = searchQuery.value.trim();
  if (query.length < 2) {
    searchResults.value = [];
    searchStatus.value = "Type at least 2 characters";
    searchLoading.value = false;
    return;
  }
  searchLoading.value = true;
  searchStatus.value = "Searching";
  searchTimer = window.setTimeout(() => {
    searchTimer = 0;
    void runSearch(query);
  }, 160);
}

async function runSearch(query: string) {
  const requestId = ++searchRequestId;
  try {
    const results = await view.assets.search(query, ["Assets", "Packages", "ProjectSettings"], 40) as AssetSearchResult[];
    if (requestId !== searchRequestId) return;
    searchResults.value = results;
    searchStatus.value = results.length ? `${results.length} results` : "No matching assets";
  } catch (error) {
    if (requestId !== searchRequestId) return;
    searchResults.value = [];
    searchStatus.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (requestId === searchRequestId) searchLoading.value = false;
  }
}

function referenceFromSearchResult(result: AssetSearchResult): UnityReference {
  return {
    kind: "asset",
    path: result.path,
    name: result.name || basenameWithoutExtension(result.path),
    typeLabel: result.typeLabel || result.kind || "Asset",
    source: "manual",
  };
}

function addSearchResult(result: AssetSearchResult) {
  addReferences([referenceFromSearchResult(result)], {
    x: searchMenu.value.anchorX,
    y: searchMenu.value.anchorY,
  });
  closeSearch();
}

function addFirstSearchResult() {
  const first = searchResults.value[0];
  if (first) addSearchResult(first);
}

function onSearchKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    closeSearch();
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    addFirstSearchResult();
  }
}

function addReferences(refs: UnityReference[], point: { x: number; y: number }) {
  if (!activePage.value || !refs.length) return;
  const selectedIds: string[] = [];
  let added = false;
  refs.forEach((refItem, index) => {
    if (!refItem.path) return;
    const path = refItem.path.trim().replace(/\\/g, "/");
    const existing = activeBlocks.value.find((block) => block.path === path && block.kind === normalizeKind(refItem.kind));
    if (existing) {
      selectedIds.push(existing.id);
      return;
    }
    const block: AssetBlock = {
      id: createId("asset"),
      kind: normalizeKind(refItem.kind),
      path,
      name: refItem.name?.trim() || basenameWithoutExtension(path),
      typeLabel: refItem.typeLabel?.trim() || (refItem.kind === "sceneObject" ? "Scene Object" : "Asset"),
      source: refItem.source === "unity" ? "unity" : "manual",
      x: point.x + index * 28,
      y: point.y + index * 28,
      width: DEFAULT_BLOCK_WIDTH,
      height: DEFAULT_BLOCK_HEIGHT,
    };
    activePage.value.blocks.push(block);
    selectedIds.push(block.id);
    added = true;
  });
  if (selectedIds.length) selectedBlockIds.value = selectedIds;
  if (added) markDirty();
}

function removeSelectedBlocks(event?: { itemIds?: string[] }) {
  if (!activePage.value) return;
  const ids = event?.itemIds?.length ? event.itemIds : selectedBlockIds.value;
  if (!ids.length) return;
  const selected = new Set(ids);
  const before = activePage.value.blocks.length;
  activePage.value.blocks = activePage.value.blocks.filter((block) => !selected.has(block.id));
  if (activePage.value.blocks.length === before) return;
  selectedBlockIds.value = [];
  markDirty();
}

function copySelection(event: { itemIds: string[] }) {
  if (!event.itemIds.length) return;
  const selected = new Set(event.itemIds);
  clipboard.value = activeBlocks.value
    .filter((block) => selected.has(block.id))
    .map((block) => ({ ...block }));
}

function pasteSelection() {
  if (!activePage.value || !clipboard.value.length) return;
  const pasted = clipboard.value.map((block, index) => ({
    ...block,
    id: createId("asset"),
    x: block.x + 36 + index * 12,
    y: block.y + 36 + index * 12,
  }));
  activePage.value.blocks.push(...pasted);
  selectedBlockIds.value = pasted.map((block) => block.id);
  markDirty();
}

function onItemMoveEnd(event: { didDrag: boolean }) {
  if (event.didDrag) markDirty();
}

async function selectBlock(block: AssetBlock | null) {
  if (!block) return;
  await unity.select(blockReference(block));
}

async function inspectBlock(block: AssetBlock | null) {
  if (!block) return;
  await unity.inspect(blockReference(block));
}

async function clearWorkspaceData() {
  const page = createPage("Page 1");
  pages.value = [page];
  activePageId.value = page.id;
  selectedBlockIds.value = [];
  clipboard.value = [];
  if (saveTimer) {
    window.clearTimeout(saveTimer);
    saveTimer = 0;
  }
  if (searchTimer) {
    window.clearTimeout(searchTimer);
    searchTimer = 0;
  }
  searchQuery.value = "";
  searchResults.value = [];
  searchStatus.value = "Type to search assets";
  searchLoading.value = false;
  dirty.value = false;
  searchMenu.value.open = false;
  try {
    await view.storage.remove(STORAGE_KEY);
    statusText.value = "Ready";
  } catch (error) {
    statusText.value = error instanceof Error ? error.message : String(error);
  }
}

function fitCanvas() {
  canvasRef.value?.fitContent?.();
}
</script>

<template>
  <main ref="mainRef" class="view-shell locus-workspace-view" data-locus-template="canvas-board">
    <header class="view-toolbar">
      <div class="toolbar-title">
        <span>Locus Workspace</span>
        <small>{{ dirty ? "Modified" : statusText }}</small>
      </div>
      <div class="page-tabs" aria-label="Workspace pages">
        <button
          v-for="page in pages"
          :key="page.id"
          type="button"
          :class="['page-tab', page.id === activePageId ? 'active' : '']"
          @click="activatePage(page.id)"
        >
          {{ page.name || "Untitled" }}
        </button>
        <button type="button" class="icon-button" title="New page" @click="addPage">+</button>
      </div>
      <div class="toolbar-actions">
        <input
          v-model="activePageName"
          class="page-name-input"
          title="Rename current page"
          @blur="normalizeActivePageName"
          @keydown.enter="blurEventTarget"
        />
        <button type="button" @click.stop="openToolbarSearch">Search</button>
        <button type="button" @click="fitCanvas">Fit</button>
        <button type="button" :disabled="!selectedBlock" @click="removeSelectedBlocks()">Delete Block</button>
        <button type="button" :disabled="pages.length <= 1" @click="deleteActivePage">Delete Page</button>
      </div>
    </header>

    <section class="workspace-main">
      <section
        ref="canvasHostRef"
        class="canvas-pane"
        @click="onCanvasClick"
        @dragenter="onCanvasDragenter"
        @dragover="onCanvasDragover"
        @dragleave="assetDrop.dragleave"
        @drop="onCanvasDrop"
      >
        <CanvasView
          ref="canvasRef"
          v-model:selected-item-ids="selectedBlockIds"
          :items="activeBlocks"
          :item-class="blockClass"
          :edit-behavior="canvasBehavior"
          @copy-selection="copySelection"
          @paste-selection="pasteSelection"
          @item-move-end="onItemMoveEnd"
          @delete-selection="removeSelectedBlocks"
          @context-menu="onCanvasContextMenu"
        >
          <template #default="{ item, selected }">
            <div class="asset-block-content" @dblclick.stop="inspectBlock(item)">
              <div class="asset-block-header">
                <span class="asset-kind">{{ item.kind === "sceneObject" ? "Scene" : "Asset" }}</span>
                <span class="asset-name" :title="item.name">{{ item.name }}</span>
                <small>{{ item.typeLabel }}</small>
              </div>
              <div class="asset-path" :title="item.path">{{ item.path }}</div>
              <div class="asset-block-actions">
                <UnityReferenceChip :reference="blockReference(item)">
                  Select / Drag
                </UnityReferenceChip>
                <button type="button" @click.stop="inspectBlock(item)">Inspect</button>
                <button v-if="selected" type="button" @click.stop="removeSelectedBlocks()">Remove</button>
              </div>
            </div>
          </template>
        </CanvasView>

        <div v-if="assetDropActive" class="drop-overlay">
          Drop Unity assets here
        </div>
      </section>

      <aside class="side-panel">
        <div class="panel-section">
          <div class="panel-title">Page</div>
          <div class="stat-row">
            <span>Blocks</span>
            <strong>{{ activeBlocks.length }}</strong>
          </div>
          <p class="hint">Drag assets from Unity, or right-click the canvas to search and add assets.</p>
        </div>

        <div class="panel-section">
          <div class="panel-title">Selected</div>
          <template v-if="selectedBlock">
            <div class="selected-name">{{ selectedBlock.name }}</div>
            <div class="selected-path">{{ selectedBlock.path }}</div>
            <div class="panel-actions">
              <button type="button" @click="selectBlock(selectedBlock)">Select</button>
              <button type="button" @click="inspectBlock(selectedBlock)">Inspect</button>
            </div>
          </template>
          <p v-else class="hint">No block selected.</p>
        </div>

        <div class="panel-section asset-list-section">
          <div class="panel-title">Assets on Page</div>
          <button
            v-for="block in activeBlocks"
            :key="block.id"
            type="button"
            :class="['asset-list-item', selectedBlockIds.includes(block.id) ? 'active' : '']"
            @click="selectedBlockIds = [block.id]"
          >
            <span>{{ block.name }}</span>
            <small>{{ block.typeLabel }}</small>
          </button>
        </div>
      </aside>

      <section v-if="searchMenu.open" class="search-popover" :style="searchPanelStyle" @click.stop @keydown.stop="onSearchKeydown">
        <div class="search-header">
          <span>Add Asset</span>
          <button type="button" class="icon-button" @click="closeSearch">×</button>
        </div>
        <input
          ref="searchInputRef"
          v-model="searchQuery"
          class="search-input"
          placeholder="Search Assets, Packages, ProjectSettings..."
          @input="scheduleSearch"
        />
        <div class="search-status">{{ searchLoading ? "Searching..." : searchStatus }}</div>
        <div class="search-results">
          <button
            v-for="result in searchResults"
            :key="result.path"
            type="button"
            class="search-result"
            @click="addSearchResult(result)"
          >
            <span>{{ result.name }}</span>
            <small>{{ result.typeLabel || result.kind || "Asset" }}</small>
            <em>{{ result.path }}</em>
          </button>
        </div>
      </section>
    </section>
  </main>
</template>
