package sh.paseo.terminal

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Rect
import android.os.Bundle
import android.view.MotionEvent
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.accessibility.AccessibilityNodeInfoCompat
import androidx.customview.widget.ExploreByTouchHelper
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

private const val MIN_CACHED_ROWS = 256
private const val CURSOR_ALPHA = 0.45f

/**
 * Paints terminal frames on the cell grid. Row shaping is cached by row content, so cursor and
 * selection changes repaint without reshaping, and unchanged rows replay their display lists.
 */
@SuppressLint("ViewConstructor")
class PaseoTerminalView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onCellMetrics by EventDispatcher<Map<String, Float>>()

  private var fontFamily = "monospace"
  private var fontSize = 12.0
  private var font: TerminalFont? = null
  private var customGlyphs = TerminalCustomGlyphs.EMPTY
  private var frame: TerminalFrameRecord? = null
  private var frameChanged = false
  private var fullInvalidatePending = true
  private val dirtyRows = LinkedHashSet<Int>()

  private var rows: List<TerminalRowLayout> = emptyList()
  private var columns = 0
  private var cursor: TerminalCursorRecord? = null
  private var selection: TerminalSelection? = null
  private var backgroundColor = Color.BLACK
  private var cursorColor = Color.WHITE
  private val paints = TerminalPaints()
  private val rowCache = object : LinkedHashMap<String, TerminalRowLayout>(64, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, TerminalRowLayout>): Boolean {
      if (size <= maxOf(MIN_CACHED_ROWS, rows.size * 2)) return false
      eldest.value.release()
      return true
    }
  }
  private val accessibility = RowAccessibility()

  init {
    setWillNotDraw(false)
    ViewCompat.setAccessibilityDelegate(this, accessibility)
  }

  fun setFrame(value: TerminalFrameRecord) {
    val previous = frame
    frame = value
    val rowsChanged = previous == null || previous.rows != value.rows
    val columnsChanged = previous == null || previous.columns != value.columns
    val cursorChanged = previous == null || !sameCursor(previous.cursor, value.cursor)
    val selectionChanged = previous == null || !sameSelection(previous.selection, value.selection)
    columns = value.columns
    cursor = value.cursor
    selection = value.selection?.let(::TerminalSelection)
    if (rowsChanged) frameChanged = true
    if (rowsChanged || columnsChanged) accessibility.invalidateRoot()

    if (previous == null || columnsChanged || previous.rows.size != value.rows.size) {
      fullInvalidatePending = true
      dirtyRows.clear()
      return
    }

    if (rowsChanged) {
      for (row in value.rows.indices) {
        if (previous.rows[row] != value.rows[row]) dirtyRows.add(row)
      }
    }
    if (cursorChanged) {
      previous.cursor?.let { dirtyRows.add(it.row) }
      value.cursor?.let { dirtyRows.add(it.row) }
    }
    if (selectionChanged) {
      markSelectionRows(previous.selection)
      markSelectionRows(value.selection)
    }
  }

  fun setTheme(value: TerminalThemeRecord) {
    backgroundColor = argb(value.background)
    cursorColor = argb(value.cursor)
    paints.selectionBackground = argb(value.selectionBackground)
    fullInvalidatePending = true
  }

  fun setFontFamily(value: String) {
    fontFamily = value
  }

  fun setFontSize(value: Double) {
    fontSize = value
  }

  fun setCustomGlyphs(value: List<TerminalCustomGlyphRecord>) {
    customGlyphs = TerminalCustomGlyphs(value)
    clearRowCache()
    frameChanged = true
    fullInvalidatePending = true
  }

  /** Applies a batch of prop updates: font first, then the frame laid out with it. */
  fun commit() {
    val density = resources.displayMetrics.density
    val sizePx = (fontSize * density).toFloat()
    val current = font
    if (current == null || !current.sameAs(fontFamily, sizePx, density)) {
      val next = TerminalFont(fontFamily, sizePx, density)
      font = next
      clearRowCache()
      frameChanged = true
      fullInvalidatePending = true
      accessibility.invalidateRoot()
      onCellMetrics(
        mapOf(
          "cellWidth" to next.cellWidthPx / density,
          "cellHeight" to next.cellHeightPx / density,
        ),
      )
    }
    if (frameChanged) {
      frameChanged = false
      layoutFrame()
    }
    invalidatePendingChanges()
  }

  private fun sameCursor(left: TerminalCursorRecord?, right: TerminalCursorRecord?): Boolean =
    left?.row == right?.row && left?.col == right?.col

  private fun sameSelection(left: TerminalSelectionRecord?, right: TerminalSelectionRecord?): Boolean =
    left?.startRow == right?.startRow &&
      left?.startCol == right?.startCol &&
      left?.endRow == right?.endRow &&
      left?.endCol == right?.endCol

  private fun markSelectionRows(record: TerminalSelectionRecord?) {
    if (record == null) return
    val first = minOf(record.startRow, record.endRow).coerceAtLeast(0)
    val last = maxOf(record.startRow, record.endRow).coerceAtMost(rows.size - 1)
    for (row in first..last) dirtyRows.add(row)
  }

  private fun invalidatePendingChanges() {
    if (fullInvalidatePending) {
      fullInvalidatePending = false
      dirtyRows.clear()
      invalidate()
      return
    }
    val currentFont = font ?: return
    if (dirtyRows.isEmpty()) return
    val cellHeight = maxOf(1, currentFont.cellHeightPx)
    for (row in dirtyRows) {
      // Adjacent rows can draw glyph ink past their own bounds.
      val top = maxOf(0, (row - 1) * cellHeight)
      val bottom = minOf(height, (row + 2) * cellHeight)
      if (bottom > top && width > 0) invalidate(0, top, width, bottom)
    }
    dirtyRows.clear()
  }

  private fun layoutFrame() {
    val currentFont = font ?: return
    val record = frame ?: return
    rows = record.rows.map { encoded ->
      rowCache.getOrPut(encoded) {
        TerminalRowLayout(TerminalRowSource.decode(encoded), currentFont, customGlyphs)
      }
    }
  }

  private fun clearRowCache() {
    for (layout in rowCache.values) layout.release()
    rowCache.clear()
    rows = emptyList()
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    canvas.drawColor(backgroundColor)
    val currentFont = font ?: return
    val cellWidth = currentFont.cellWidthPx
    val cellHeight = currentFont.cellHeightPx
    val gridWidth = columns * cellWidth
    val clip = canvas.clipBounds
    val firstRow = (clip.top / cellHeight - 1).coerceAtLeast(0)
    val lastRow = (clip.bottom / cellHeight + 1).coerceAtMost(rows.lastIndex)
    canvas.save()
    canvas.clipRect(0, 0, minOf(width, gridWidth), height)
    val activeSelection = selection
    for (index in firstRow..lastRow) {
      val row = rows[index]
      canvas.save()
      canvas.translate(0f, (index * cellHeight).toFloat())
      if (activeSelection != null && activeSelection.intersectsRow(index)) {
        row.drawSelected(canvas, index, activeSelection, paints)
      } else {
        row.draw(canvas, gridWidth, paints)
      }
      canvas.restore()
    }
    cursor?.let { position ->
      paints.fill.color = withAlpha(cursorColor, CURSOR_ALPHA)
      val left = (position.col * cellWidth).toFloat()
      val top = (position.row * cellHeight).toFloat()
      canvas.drawRect(left, top, left + cellWidth, top + cellHeight, paints.fill)
    }
    canvas.restore()
  }

  override fun dispatchHoverEvent(event: MotionEvent): Boolean =
    accessibility.dispatchHoverEvent(event) || super.dispatchHoverEvent(event)

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    for (layout in rowCache.values) layout.release()
  }

  private fun withAlpha(color: Int, alpha: Float): Int =
    Color.argb((Color.alpha(color) * alpha).toInt(), Color.red(color), Color.green(color), Color.blue(color))

  /** Exposes each non-blank row as a virtual text node, `terminal-row-<index>`. */
  private inner class RowAccessibility : ExploreByTouchHelper(this@PaseoTerminalView) {
    override fun getVirtualViewAt(x: Float, y: Float): Int {
      val cellHeight = font?.cellHeightPx ?: return INVALID_ID
      val row = (y / cellHeight).toInt()
      return if (row in rows.indices && rows[row].describe().isNotEmpty()) row else INVALID_ID
    }

    override fun getVisibleVirtualViews(virtualViewIds: MutableList<Int>) {
      for ((index, row) in rows.withIndex()) {
        if (row.describe().isNotEmpty()) virtualViewIds.add(index)
      }
    }

    @Suppress("DEPRECATION")
    override fun onPopulateNodeForVirtualView(virtualViewId: Int, node: AccessibilityNodeInfoCompat) {
      val cellHeight = font?.cellHeightPx ?: 1
      val label = rows.getOrNull(virtualViewId)?.describe().orEmpty()
      node.className = TextView::class.java.name
      node.text = label
      node.contentDescription = label
      node.viewIdResourceName = "terminal-row-$virtualViewId"
      val top = virtualViewId * cellHeight
      node.setBoundsInParent(Rect(0, top, minOf(width, columns * (font?.cellWidthPx ?: 1)), top + cellHeight))
    }

    override fun onPerformActionForVirtualView(virtualViewId: Int, action: Int, arguments: Bundle?): Boolean = false
  }
}
