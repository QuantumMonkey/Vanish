// Vanish renderer -- reusable column filters (bd vanish-uninstaller-5b0)
//
// One implementation, shared by every real column-header table in the app:
// All Programs (Publisher, Type), Task Manager (Process, Indicators) and the
// Health Advisor startup table (Source, Status). Classic script like the rest
// of renderer/ - no imports, no exports, plain globals, no dependency added.
//
// Four decisions in here are load-bearing and were made deliberately.
//
// 1. STATE IS THE SET OF EXCLUDED VALUES, never the set of selected ones.
//    These tables are fed live data: a process starts, a program is removed, a
//    new indicator kind ships. Under "selected" semantics any value that did
//    not exist when the popover was last opened would default to HIDDEN, so a
//    brand-new row would be withheld by a filter the user believes is about
//    something else entirely. Excluded-set semantics fail the other way -
//    something new always shows up - and showing too much is the direction
//    this project errs in on purpose.
//
// 2. THE OPTION LIST IS BUILT FROM THE VIEW'S WHOLE POOL, not from the rows
//    that survive the filters currently applied. An option list that shrinks
//    as you uncheck things is a trap with no way out: the value just hidden
//    would disappear from the only control that could bring it back.
//
// 3. A ROW CARRYING SEVERAL VALUES (Task Manager's Indicators) MATCHES IF ANY
//    ONE OF ITS VALUES IS STILL SHOWN. Equality would silently under-report a
//    process carrying two indicators, which is the honesty failure this app
//    keeps having to fix. Rows carrying no value at all get one synthetic
//    "(none)" bucket, so they can be filtered deliberately rather than being
//    unconditionally present or unconditionally gone.
//
// 4. FILTER STATE IS RENDERER MEMORY ONLY and is never persisted. A filter the
//    user forgot they set, restored silently on the next launch, is the same
//    class of bug as the 2026-08-05 silent search filter - and that one cost
//    an operator report and a whole caption row to fix.

const COLUMN_FILTER_NONE = '(none)';
// Above this many distinct values a popover needs its own search box. Type has
// three; Publisher on a real machine has well over a hundred.
const COLUMN_FILTER_SEARCH_THRESHOLD = 12;

// key -> Set of excluded values. Absent or empty means "this column filters
// nothing", which is what every caption and chip test keys on.
const columnFilterExcluded = new Map();
// key -> spec, so chips, captions and Clear can resolve a column by name after
// the fact rather than each view re-describing its own columns.
const columnFilterSpecs = new Map();

let columnFilterOpenKey = null;
let columnFilterDismissWired = false;

// spec: { key, label, th, getPool, getValues, onChange, note }
//   key      stable per (view, column) - 'apps.type', 'process.indicators'
//   th       the header cell, or a selector for it
//   getPool  () => every row the view could show, ignoring all filters
//   getValues(row) => one value, or an array for a multi-valued column
//   onChange () => re-render that view
function registerColumnFilter(spec) {
  columnFilterSpecs.set(spec.key, spec);

  const th = typeof spec.th === 'string' ? document.querySelector(spec.th) : spec.th;
  if (!th) return null;
  if (th.querySelector('.column-filter-btn')) return spec; // already wired

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'column-filter-btn';
  btn.setAttribute('data-filter-key', spec.key);
  btn.setAttribute('aria-haspopup', 'true');
  btn.setAttribute('aria-expanded', 'false');
  btn.title = `Filter by ${spec.label}`;
  btn.innerHTML = '<i class="fa-solid fa-filter"></i>';
  // Task Manager's headers sort on click. Without this the funnel would also
  // re-sort the table underneath the popover it just opened.
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    toggleColumnFilterPopover(spec.key);
  });

  th.classList.add('has-column-filter');
  th.appendChild(btn);
  wireColumnFilterDismiss();
  updateColumnFilterButton(spec.key);
  return spec;
}

// Every value a row carries, normalised: trimmed strings, de-duplicated, and
// never empty - a row with nothing in this column belongs to "(none)".
function columnFilterValuesFor(spec, row) {
  let raw = spec.getValues(row);
  if (!Array.isArray(raw)) raw = raw === undefined || raw === null ? [] : [raw];
  const out = [];
  for (const value of raw) {
    const text = String(value === undefined || value === null ? '' : value).trim();
    if (text === '') continue;
    if (!out.includes(text)) out.push(text);
  }
  return out.length ? out : [COLUMN_FILTER_NONE];
}

function columnFilterActive(key) {
  const excluded = columnFilterExcluded.get(key);
  return !!excluded && excluded.size > 0;
}

function activeColumnFilterKeys(keys) {
  return keys.filter((key) => columnFilterActive(key));
}

// Does one row survive one column's filter? See decision 3 above for why this
// is "any value still shown" and not equality.
function columnFilterAllows(key, row) {
  const excluded = columnFilterExcluded.get(key);
  if (!excluded || excluded.size === 0) return true;
  const spec = columnFilterSpecs.get(key);
  if (!spec) return true;
  return columnFilterValuesFor(spec, row).some((value) => !excluded.has(value));
}

// Several columns of one view at once. AND, and it has to be AND: two filters
// that OR'd would widen the list as the user narrows it.
function columnFilterAllowsAll(keys, row) {
  return keys.every((key) => columnFilterAllows(key, row));
}

// 'Type, Publisher' - for the row-count caption, which must name what is
// holding rows back, not merely admit that something is.
function columnFilterSummary(keys) {
  return activeColumnFilterKeys(keys)
    .map((key) => {
      const spec = columnFilterSpecs.get(key);
      return spec ? spec.label : key;
    })
    .join(', ');
}

function clearColumnFilter(key, { notify = true } = {}) {
  columnFilterExcluded.delete(key);
  updateColumnFilterButton(key);
  const spec = columnFilterSpecs.get(key);
  if (notify && spec && typeof spec.onChange === 'function') spec.onChange();
}

// Used by the views' own "Clear" actions, which re-render once themselves
// afterwards rather than once per column.
function clearColumnFilters(keys, { notify = false } = {}) {
  keys.forEach((key) => clearColumnFilter(key, { notify }));
}

// The distinct values present in the pool, with a count each, plus any value
// the user has hidden that has since left the data - dropping those would
// leave a filter active with nothing on screen able to switch it off.
function columnFilterOptions(spec) {
  const pool = (typeof spec.getPool === 'function' ? spec.getPool() : []) || [];
  const counts = new Map();
  pool.forEach((row) => {
    columnFilterValuesFor(spec, row).forEach((value) => {
      counts.set(value, (counts.get(value) || 0) + 1);
    });
  });

  const excluded = columnFilterExcluded.get(spec.key) || new Set();
  excluded.forEach((value) => {
    if (!counts.has(value)) counts.set(value, 0);
  });

  return Array.from(counts.entries())
    .map(([value, count]) => ({ value, count, shown: !excluded.has(value) }))
    .sort((a, b) => {
      // "None" last, always: it is a bucket this code invented, not a value the
      // machine reported, and it should not sit above real data.
      if (a.value === COLUMN_FILTER_NONE) return 1;
      if (b.value === COLUMN_FILTER_NONE) return -1;
      return a.value.localeCompare(b.value);
    });
}

function columnFilterDisplayValue(value) {
  return value === COLUMN_FILTER_NONE ? 'None' : value;
}

function updateColumnFilterButton(key) {
  const btn = document.querySelector(`.column-filter-btn[data-filter-key="${key}"]`);
  if (!btn) return;
  const active = columnFilterActive(key);
  btn.classList.toggle('is-active', active);
  const spec = columnFilterSpecs.get(key);
  const label = spec ? spec.label : key;
  btn.title = active
    ? `${label} filter is on - click to change it`
    : `Filter by ${label}`;
}

// One popover element reused by every column, appended to body rather than to
// the header: the header is sticky with its own stacking context, and a
// popover parented inside it gets clipped by the table's scroll box.
function columnFilterPopover() {
  let pop = document.getElementById('column-filter-pop');
  if (!pop) {
    pop = document.createElement('div');
    pop.id = 'column-filter-pop';
    pop.className = 'column-filter-pop';
    document.body.appendChild(pop);
  }
  return pop;
}

function toggleColumnFilterPopover(key) {
  if (columnFilterOpenKey === key) closeColumnFilterPopover();
  else openColumnFilterPopover(key);
}

function closeColumnFilterPopover() {
  const pop = document.getElementById('column-filter-pop');
  if (pop) pop.style.display = 'none';
  if (columnFilterOpenKey) {
    const btn = document.querySelector(`.column-filter-btn[data-filter-key="${columnFilterOpenKey}"]`);
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }
  columnFilterOpenKey = null;
}

function openColumnFilterPopover(key) {
  const spec = columnFilterSpecs.get(key);
  if (!spec) return;
  const btn = document.querySelector(`.column-filter-btn[data-filter-key="${key}"]`);
  if (!btn) return;

  const pop = columnFilterPopover();
  const options = columnFilterOptions(spec);
  const withSearch = options.length > COLUMN_FILTER_SEARCH_THRESHOLD;
  const lowerLabel = spec.label.toLowerCase();

  pop.innerHTML = `
    <div class="column-filter-head">
      <span>Show which ${esc(lowerLabel)}?</span>
      <button type="button" class="column-filter-close" title="Close"><i class="fa-solid fa-xmark"></i></button>
    </div>
    ${spec.note ? `<div class="column-filter-note">${esc(spec.note)}</div>` : ''}
    ${withSearch
      ? `<input type="text" class="column-filter-search" placeholder="Search ${esc(lowerLabel)}" autocomplete="off">`
      : ''}
    <div class="column-filter-actions">
      <button type="button" data-bulk="all">All</button>
      <button type="button" data-bulk="none">None</button>
      <button type="button" data-bulk="invert">Invert</button>
    </div>
    <div class="column-filter-list">
      ${options
        .map(
          (option) => `
        <label class="column-filter-option" data-value="${esc(option.value)}">
          <input type="checkbox"${option.shown ? ' checked' : ''}>
          <span class="column-filter-value" title="${esc(columnFilterDisplayValue(option.value))}">${esc(
            columnFilterDisplayValue(option.value)
          )}</span>
          <span class="column-filter-count">${esc(option.count)}</span>
        </label>`
        )
        .join('')}
    </div>
  `;

  // The checkboxes are the source of truth while the popover is open, so the
  // list is never rebuilt mid-session: re-sorting or re-counting under the
  // user's cursor would move the row they were about to click.
  const applyFromBoxes = () => {
    const excluded = new Set();
    pop.querySelectorAll('.column-filter-option').forEach((label) => {
      const box = label.querySelector('input[type="checkbox"]');
      if (box && !box.checked) excluded.add(label.getAttribute('data-value'));
    });
    if (excluded.size === 0) columnFilterExcluded.delete(key);
    else columnFilterExcluded.set(key, excluded);
    updateColumnFilterButton(key);
    if (typeof spec.onChange === 'function') spec.onChange();
  };

  pop.querySelectorAll('.column-filter-option input[type="checkbox"]').forEach((box) => {
    box.addEventListener('change', applyFromBoxes);
  });

  pop.querySelectorAll('.column-filter-actions button').forEach((actionBtn) => {
    actionBtn.addEventListener('click', () => {
      const mode = actionBtn.getAttribute('data-bulk');
      // All/None/Invert act on the values the popover's own search is showing,
      // not on every value in the column. Typing "micro" then pressing None and
      // having it hide all 140 publishers would be a different action from the
      // one it looks like.
      const visible = Array.from(pop.querySelectorAll('.column-filter-option')).filter(
        (label) => label.style.display !== 'none'
      );
      visible.forEach((label) => {
        const box = label.querySelector('input[type="checkbox"]');
        if (!box) return;
        if (mode === 'all') box.checked = true;
        else if (mode === 'none') box.checked = false;
        else box.checked = !box.checked;
      });
      applyFromBoxes();
    });
  });

  const search = pop.querySelector('.column-filter-search');
  if (search) {
    search.addEventListener('input', () => {
      const term = search.value.trim().toLowerCase();
      pop.querySelectorAll('.column-filter-option').forEach((label) => {
        const value = String(label.getAttribute('data-value') || '').toLowerCase();
        label.style.display = term === '' || value.includes(term) ? '' : 'none';
      });
    });
  }

  const closeBtn = pop.querySelector('.column-filter-close');
  if (closeBtn) closeBtn.addEventListener('click', () => closeColumnFilterPopover());

  columnFilterOpenKey = key;
  btn.setAttribute('aria-expanded', 'true');
  pop.style.display = 'flex';
  // Positioned after it has a box, so its measured height decides whether it
  // opens downwards or flips above the header.
  positionColumnFilterPopover(btn, pop);
  if (search) search.focus();
}

function positionColumnFilterPopover(btn, pop) {
  // h0i made these headers sticky, so the header's LIVE rect is the only
  // correct anchor - its layout position in the table is wherever the body
  // has been scrolled to, which is not where it is on screen.
  const rect = btn.getBoundingClientRect();
  const width = pop.offsetWidth || 240;
  const height = pop.offsetHeight || 280;

  let left = rect.left;
  if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
  if (left < 8) left = 8;

  let top = rect.bottom + 6;
  if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);

  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
}

function wireColumnFilterDismiss() {
  if (columnFilterDismissWired) return;
  columnFilterDismissWired = true;

  document.addEventListener('click', (e) => {
    if (!columnFilterOpenKey) return;
    if (e.target.closest('#column-filter-pop')) return;
    if (e.target.closest('.column-filter-btn')) return;
    closeColumnFilterPopover();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && columnFilterOpenKey) closeColumnFilterPopover();
  });

  // A scroll moves the sticky header the popover is hanging from. Closing is
  // honest; a popover left floating beside the wrong column is not.
  document.addEventListener('scroll', () => closeColumnFilterPopover(), true);
  window.addEventListener('resize', () => closeColumnFilterPopover());
}

// Chips above the table, one per active column, each removable. A filtered
// view that looks identical to an unfiltered one is the exact confusion the
// 7oo epic and the 2026-08-05 report were both about, so these are not
// decoration - they are the second, always-visible copy of the filter state.
function renderColumnFilterChips(containerId, keys) {
  const box = document.getElementById(containerId);
  if (!box) return;

  const active = activeColumnFilterKeys(keys);
  if (active.length === 0) {
    box.innerHTML = '';
    box.style.display = 'none';
    return;
  }

  box.style.display = '';
  box.innerHTML = active
    .map((key) => {
      const spec = columnFilterSpecs.get(key);
      const options = spec ? columnFilterOptions(spec) : [];
      const shown = options.filter((option) => option.shown).length;
      const hidden = options.length - shown;
      const label = spec ? spec.label : key;
      return `
        <button type="button" class="column-filter-chip" data-filter-key="${esc(key)}"
                title="${esc(`${hidden} ${label.toLowerCase()} value${hidden === 1 ? '' : 's'} hidden - click to show all again`)}">
          <span>${esc(label)}: ${esc(shown)} of ${esc(options.length)}</span>
          <i class="fa-solid fa-xmark"></i>
        </button>`;
    })
    .join('');

  box.querySelectorAll('.column-filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => clearColumnFilter(chip.getAttribute('data-filter-key')));
  });
}
