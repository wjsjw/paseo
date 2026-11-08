import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import type { TerminalCharacterWidths } from "../character-widths";
import {
  Terminal as HeadlessTerminal,
  type IBufferCell,
  type IBufferLine,
  type Terminal as HeadlessTerminalInstance,
} from "@xterm/headless";
import type { TerminalCell, TerminalState } from "@getpaseo/protocol/messages";

export type NativeTerminalWriteData = Uint8Array | string;
export interface NativeTerminalCell extends TerminalCell {
  width?: number;
}

export type TerminalCellRow = NativeTerminalCell[];

export interface NativeHeadlessTerminalOptions {
  rows: number;
  cols: number;
  scrollbackLines?: number;
  /** Defaults to `graphemes`, the table current daemons use. */
  characterWidths?: TerminalCharacterWidths;
}

export interface NativeHeadlessTerminal {
  write(data: NativeTerminalWriteData): Promise<void>;
  getViewportState(input?: TerminalViewportStateInput): TerminalViewportState;
  getInputModeState(): NativeHeadlessTerminalInputModeState;
  getBufferBounds(): TerminalBufferBounds;
  getBufferWindow(input: TerminalBufferWindowInput): TerminalBufferWindow;
  resize(input: { rows: number; cols: number }): void;
  reset(): void;
  dispose(): void;
}

export interface NativeHeadlessTerminalInputModeState {
  applicationCursorKeys: boolean;
  bracketedPaste: boolean;
}

export interface TerminalBufferWindowInput {
  startRow: number;
  rowCount: number;
}

export interface TerminalViewportStateInput {
  firstRow: number;
  rowCount: number;
}

export interface TerminalRowRange {
  firstRow: number;
  lastRow: number;
}

export interface TerminalBufferBounds {
  rows: number;
  cols: number;
  oldestRow: number;
  newestRow: number;
  coordinateEpoch: number;
  currentViewport: TerminalRowRange;
  bottomViewport: TerminalRowRange;
  cursorRow: number;
  cursorCol: number;
}

export interface TerminalBufferWindow {
  startRow: number;
  rows: TerminalCellRow[];
  wrappedRows: boolean[];
}

export interface TerminalViewportState {
  rows: number;
  cols: number;
  firstRow: number;
  oldestRow: number;
  newestRow: number;
  grid: TerminalCell[][];
  cursor: TerminalState["cursor"];
}

interface XtermCoreService {
  decPrivateModes?: {
    applicationCursorKeys?: unknown;
    bracketedPasteMode?: unknown;
    cursorStyle?: unknown;
    cursorBlink?: unknown;
  };
  isCursorHidden?: unknown;
}

interface HeadlessTerminalWithCore {
  _core?: {
    coreService?: XtermCoreService;
    _bufferService?: {
      buffer?: {
        lines?: {
          onTrim?: (listener: (amount: number) => void) => { dispose(): void };
        };
      };
    };
  };
}

interface TerminalCoordinateStorage {
  oldestRow: number;
  trimSubscription: { dispose(): void } | null;
}

interface ResolvedBufferWindow {
  startRow: number;
  endRow: number;
}

interface CachedViewportRows {
  firstRow: number;
  rowCount: number;
  cols: number;
  coordinateEpoch: number;
  rows: TerminalCellRow[];
}

function activeBufferLines(terminal: HeadlessTerminalInstance) {
  return (terminal as unknown as HeadlessTerminalWithCore)._core?._bufferService?.buffer?.lines;
}

function blankCell(): NativeTerminalCell {
  return { char: " ", width: 1, fg: undefined, bg: undefined };
}

function terminalRowsEqual(left: TerminalCellRow, right: TerminalCellRow): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const previous = left[index]!;
    const next = right[index]!;
    if (
      previous.char !== next.char ||
      previous.width !== next.width ||
      previous.fg !== next.fg ||
      previous.bg !== next.bg ||
      previous.fgMode !== next.fgMode ||
      previous.bgMode !== next.bgMode ||
      previous.bold !== next.bold ||
      previous.italic !== next.italic ||
      previous.underline !== next.underline ||
      previous.dim !== next.dim ||
      previous.inverse !== next.inverse ||
      previous.strikethrough !== next.strikethrough
    ) {
      return false;
    }
  }
  return true;
}

function extractCell(
  line: IBufferLine | undefined,
  col: number,
  reusableCell: IBufferCell,
): NativeTerminalCell {
  if (!line) {
    return blankCell();
  }

  const cell = line.getCell(col, reusableCell);
  if (!cell) {
    return blankCell();
  }

  const fgModeRaw = cell.getFgColorMode();
  const bgModeRaw = cell.getBgColorMode();
  const fgMode = fgModeRaw >> 24;
  const bgMode = bgModeRaw >> 24;
  const fg = fgMode !== 0 ? cell.getFgColor() : undefined;
  const bg = bgMode !== 0 ? cell.getBgColor() : undefined;

  return {
    char: cell.getChars() || " ",
    width: cell.getWidth(),
    fg,
    bg,
    fgMode: fgMode !== 0 ? fgMode : undefined,
    bgMode: bgMode !== 0 ? bgMode : undefined,
    bold: cell.isBold() !== 0,
    italic: cell.isItalic() !== 0,
    underline: cell.isUnderline() !== 0,
    dim: cell.isDim() !== 0,
    inverse: cell.isInverse() !== 0,
    strikethrough: cell.isStrikethrough() !== 0,
  };
}

function extractRow(
  terminal: HeadlessTerminalInstance,
  row: number,
  reusableCell: IBufferCell,
): TerminalCellRow {
  const line = terminal.buffer.active.getLine(row);
  const rowCells: NativeTerminalCell[] = [];
  for (let col = 0; col < terminal.cols; col += 1) {
    rowCells.push(extractCell(line, col, reusableCell));
  }
  return rowCells;
}

function extractBufferWindow(
  terminal: HeadlessTerminalInstance,
  oldestRow: number,
  input: TerminalBufferWindowInput,
): TerminalBufferWindow {
  const { startRow, endRow } = resolveBufferWindow(terminal, oldestRow, input);
  const reusableCell = terminal.buffer.active.getNullCell();
  const rows: TerminalCellRow[] = [];
  const wrappedRows: boolean[] = [];

  for (let row = startRow; row < endRow; row += 1) {
    const bufferRow = row - oldestRow;
    const line = terminal.buffer.active.getLine(bufferRow);
    rows.push(extractRow(terminal, bufferRow, reusableCell));
    wrappedRows.push(line?.isWrapped === true);
  }

  return { startRow, rows, wrappedRows };
}

function resolveBufferWindow(
  terminal: HeadlessTerminalInstance,
  oldestRow: number,
  input: TerminalBufferWindowInput,
): ResolvedBufferWindow {
  const rowCount = Math.max(0, Math.floor(input.rowCount));
  const newestRow = oldestRow + terminal.buffer.active.length - 1;
  const startRow = Math.min(Math.max(oldestRow, Math.floor(input.startRow)), newestRow + 1);
  return { startRow, endRow: Math.min(newestRow + 1, startRow + rowCount) };
}

function rowRange(firstRow: number, rowCount: number): TerminalRowRange {
  return {
    firstRow,
    lastRow: Math.max(firstRow, firstRow + Math.max(1, rowCount) - 1),
  };
}

function extractBufferBounds(
  terminal: HeadlessTerminalInstance,
  coordinateEpoch: number,
  oldestRow: number,
): TerminalBufferBounds {
  const buffer = terminal.buffer.active;
  const length = Math.max(1, buffer.length);
  const newestRow = oldestRow + length - 1;
  const bottomFirstRow = Math.max(oldestRow, newestRow - terminal.rows + 1);
  const currentFirstRow = Math.min(Math.max(oldestRow, oldestRow + buffer.baseY), bottomFirstRow);

  return {
    rows: terminal.rows,
    cols: terminal.cols,
    oldestRow,
    newestRow,
    coordinateEpoch,
    currentViewport: rowRange(currentFirstRow, terminal.rows),
    bottomViewport: rowRange(bottomFirstRow, terminal.rows),
    cursorRow: oldestRow + buffer.baseY + buffer.cursorY,
    cursorCol: buffer.cursorX,
  };
}

function extractCursorState(
  terminal: HeadlessTerminalInstance,
  window?: TerminalViewportStateInput,
  oldestRow = 0,
): TerminalState["cursor"] {
  const coreService = (terminal as unknown as HeadlessTerminalWithCore)._core?.coreService;
  const cursorStyle = coreService?.decPrivateModes?.cursorStyle;
  const normalizedCursorStyle =
    cursorStyle === "block" || cursorStyle === "underline" || cursorStyle === "bar"
      ? cursorStyle
      : undefined;
  const cursorBlink =
    typeof coreService?.decPrivateModes?.cursorBlink === "boolean"
      ? coreService.decPrivateModes.cursorBlink
      : undefined;
  const cursorRow = oldestRow + terminal.buffer.active.baseY + terminal.buffer.active.cursorY;
  const relativeCursorRow = window ? cursorRow - window.firstRow : terminal.buffer.active.cursorY;
  const hiddenByWindow = window
    ? relativeCursorRow < 0 || relativeCursorRow >= Math.max(0, Math.floor(window.rowCount))
    : false;
  const hidden = Boolean(coreService?.isCursorHidden) || hiddenByWindow;

  return {
    row: relativeCursorRow,
    col: terminal.buffer.active.cursorX,
    ...(hidden ? { hidden: true } : {}),
    ...(normalizedCursorStyle ? { style: normalizedCursorStyle } : {}),
    ...(typeof cursorBlink === "boolean" ? { blink: cursorBlink } : {}),
  };
}

function extractInputModeState(
  terminal: HeadlessTerminalInstance,
): NativeHeadlessTerminalInputModeState {
  const coreService = (terminal as unknown as HeadlessTerminalWithCore)._core?.coreService;
  return {
    applicationCursorKeys: coreService?.decPrivateModes?.applicationCursorKeys === true,
    bracketedPaste: coreService?.decPrivateModes?.bracketedPasteMode === true,
  };
}

export function createNativeHeadlessTerminal(
  options: NativeHeadlessTerminalOptions,
): NativeHeadlessTerminal {
  const terminal = new HeadlessTerminal({
    rows: options.rows,
    cols: options.cols,
    scrollback: options.scrollbackLines ?? 1000,
    allowProposedApi: true,
  });
  // Grapheme widths give each emoji cluster one two-column cell, the width the
  // native renderer draws it at. Legacy hosts measure with xterm's default
  // table, so their cursor reports and replay stay consistent with it.
  if ((options.characterWidths ?? "graphemes") === "graphemes") {
    terminal.loadAddon(new UnicodeGraphemesAddon());
  }
  const decoder = new TextDecoder();
  let coordinateEpoch = 0;
  const coordinateStorage = new Map<object, TerminalCoordinateStorage>();
  let cachedViewportRows: CachedViewportRows | null = null;
  let refreshAllViewportRows = true;
  const dirtyBufferRows = new Set<number>();

  function markAllViewportRowsDirty(): void {
    refreshAllViewportRows = true;
    dirtyBufferRows.clear();
  }

  function getActiveCoordinateStorage(): TerminalCoordinateStorage {
    const lines = activeBufferLines(terminal);
    if (!lines) {
      throw new Error("Native terminal buffer storage is unavailable");
    }
    const existing = coordinateStorage.get(lines);
    if (existing) {
      return existing;
    }
    const storage: TerminalCoordinateStorage = { oldestRow: 0, trimSubscription: null };
    storage.trimSubscription =
      lines.onTrim?.((amount) => {
        storage.oldestRow += amount;
      }) ?? null;
    coordinateStorage.set(lines, storage);
    return storage;
  }

  getActiveCoordinateStorage();
  const bufferChangeSubscription = terminal.buffer.onBufferChange(() => {
    coordinateEpoch += 1;
    getActiveCoordinateStorage();
    markAllViewportRowsDirty();
  });
  const renderSubscription = terminal.onRender(({ start, end }) => {
    const bounds = extractBufferBounds(
      terminal,
      coordinateEpoch,
      getActiveCoordinateStorage().oldestRow,
    );
    for (let row = start; row <= end; row += 1) {
      dirtyBufferRows.add(bounds.currentViewport.firstRow + row);
    }
  });
  const scrollSubscription = terminal.onScroll(markAllViewportRowsDirty);
  const resizeSubscription = terminal.onResize(markAllViewportRowsDirty);

  function getViewportState(input?: TerminalViewportStateInput): TerminalViewportState {
    const oldestRow = getActiveCoordinateStorage().oldestRow;
    const bounds = extractBufferBounds(terminal, coordinateEpoch, oldestRow);
    const requestedRowCount = input ? Math.max(0, Math.floor(input.rowCount)) : terminal.rows;
    const requestedFirstRow = input ? input.firstRow : bounds.currentViewport.firstRow;
    const window = resolveBufferWindow(terminal, oldestRow, {
      startRow: requestedFirstRow,
      rowCount: requestedRowCount,
    });
    const firstRow = window.startRow;
    const rowCount = window.endRow - window.startRow;
    const cache = cachedViewportRows;
    const canReuseRows =
      !refreshAllViewportRows &&
      cache !== null &&
      cache.firstRow === firstRow &&
      cache.rowCount === rowCount &&
      cache.cols === terminal.cols &&
      cache.coordinateEpoch === coordinateEpoch;
    let grid: TerminalCellRow[];

    if (!canReuseRows) {
      grid = extractBufferWindow(terminal, oldestRow, {
        startRow: firstRow,
        rowCount,
      }).rows;
    } else {
      grid = cache.rows.slice();
      for (const dirtyRow of dirtyBufferRows) {
        const viewportRow = dirtyRow - firstRow;
        if (viewportRow < 0 || viewportRow >= grid.length) {
          continue;
        }
        const [row] = extractBufferWindow(terminal, oldestRow, {
          startRow: dirtyRow,
          rowCount: 1,
        }).rows;
        if (row && !terminalRowsEqual(grid[viewportRow]!, row)) {
          grid[viewportRow] = row;
        }
      }
    }

    dirtyBufferRows.clear();
    refreshAllViewportRows = false;
    cachedViewportRows = {
      firstRow,
      rowCount,
      cols: terminal.cols,
      coordinateEpoch,
      rows: grid,
    };

    return {
      rows: grid.length,
      cols: terminal.cols,
      firstRow,
      oldestRow: bounds.oldestRow,
      newestRow: bounds.newestRow,
      grid,
      cursor: extractCursorState(terminal, { firstRow, rowCount: grid.length }, oldestRow),
    };
  }

  return {
    async write(data: NativeTerminalWriteData): Promise<void> {
      const text = typeof data === "string" ? data : decoder.decode(data, { stream: true });
      if (text.length === 0) {
        return;
      }
      await new Promise<void>((resolve) => {
        terminal.write(text, () => {
          resolve();
        });
      });
    },
    getViewportState(input?: TerminalViewportStateInput): TerminalViewportState {
      return getViewportState(input);
    },
    getInputModeState(): NativeHeadlessTerminalInputModeState {
      return extractInputModeState(terminal);
    },
    getBufferBounds(): TerminalBufferBounds {
      return extractBufferBounds(terminal, coordinateEpoch, getActiveCoordinateStorage().oldestRow);
    },
    getBufferWindow(input: TerminalBufferWindowInput): TerminalBufferWindow {
      return extractBufferWindow(terminal, getActiveCoordinateStorage().oldestRow, input);
    },
    resize(input: { rows: number; cols: number }): void {
      coordinateEpoch += 1;
      markAllViewportRowsDirty();
      terminal.resize(input.cols, input.rows);
    },
    reset(): void {
      coordinateEpoch += 1;
      markAllViewportRowsDirty();
      decoder.decode();
      terminal.reset();
      getActiveCoordinateStorage().oldestRow = 0;
    },
    dispose(): void {
      bufferChangeSubscription.dispose();
      renderSubscription.dispose();
      scrollSubscription.dispose();
      resizeSubscription.dispose();
      for (const storage of coordinateStorage.values()) {
        storage.trimSubscription?.dispose();
      }
      terminal.dispose();
    },
  };
}
