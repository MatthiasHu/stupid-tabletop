"use strict";

// address for stupid-sync connection
const domain = "wss://schwubbl.de/stupid-sync-entry";

const scaleSensitivity = 1.05;

// canvas element and drawing context
let canvas: HTMLCanvasElement;
let context: CanvasRenderingContext2D;

// UI elements
type UI =
  { tableNameText: HTMLInputElement
  , tableNameButton: HTMLButtonElement
  , newItemDiv: HTMLDivElement
  , newItemText: HTMLInputElement
  , newItemButton: HTMLButtonElement
  , notConnectedLabel: HTMLDivElement
  };
let ui: UI;

type ItemId = number;

//list of items selected for drag&drop
let selectedItemIds: ItemId[] = [];

type PlayerId = string;

type Point = {x: number, y: number};
// Should we use separate point types for separete coordinate systems?
// (TypeScript has no "newtype"s.)

type Size = {w: number, h: number};

type Item =
  { id: ItemId
  , imgurl: string
  , center: Point
  , scale: number
  , locked: boolean
  , faceDown: boolean
  , isPlayerArea: null | PlayerId
  }
// locked == false implies isPlayerArea == null.

// the data to be synced: an array of items
let items: Item[] = [];

type ItemImage = {image: HTMLImageElement, loaded: boolean};

// image data
const images: Map<string, ItemImage> = new Map();

// last known mouse position
// (in table coordinates)
// or null (if mouse is not pressed or outside the canvas)
let lastDragPos: Point | null = null;

// Set on mouse down event.
let dragging: null | "items" | "table" = null;

// Send sync data on mouse up?
// (Implies dragging == "items".)
let itemsHaveBeenDragged: boolean = false;

// Has data last been sent or received?
let lastSyncEvent: "sent" | "received" | null = null;

// current view transformation (translation and scale)
let transformation = {t: {x: 0, y: 0}, s: 1};
// [table coords] ---(scaling)---(translation)--- [canvas coords]

// the websocket
// null when there is no current connection or conntection attempt
let socket: WebSocket | null = null;

// Randomly generated identifier for this player.
const myPlayerId = "player" + Math.floor(Math.random()*1000000);


function onLoad() {
  const get = (id: string) => document.getElementById(id);

  canvas = get("bigcanvas") as HTMLCanvasElement;
  const c = canvas.getContext("2d");
  if (c === null) {
    console.log("canvas.getContext(\"2d\") === null");
    return;
  }
  context = c;

  ui =
    { tableNameText: get("table-name-text") as HTMLInputElement
    , tableNameButton: get("table-name-button") as HTMLButtonElement
    , newItemDiv: get("new-item-div") as HTMLDivElement
    , newItemText: get("new-item-text") as HTMLInputElement
    , newItemButton: get("new-item-button") as HTMLButtonElement
    , notConnectedLabel: get("not-connected-label") as HTMLDivElement
    };

  ui.tableNameButton.onclick = tryConnect;
  ui.tableNameText.oninput = disconnect;
  ui.newItemButton.onclick = onAddNewItem;

  toggleNewItemDiv(false);

  centerViewOn({x: 0, y: 0})
  onResize();
  window.onresize = onResize;

  // input handlers
  canvas.onmousedown = onMouseDown;
  canvas.ondblclick = onDblClick;
  canvas.onmousemove = onMouseMove;
  canvas.onmouseout = onMouseOut;
  canvas.onmouseup = onMouseUp;
  canvas.onkeydown = onKeyDown;
  // (the canvas has a tabindex for onkeydown to work)
  canvas.onwheel = onWheel;

  // get key events right away
  canvas.focus();

  ui.tableNameText.value = tableNameFromURL();
  tryConnect();
}

function tableNameFromURL(): string {
  let table = "default";
  const equations = window.location.search.substring(1).split("&");
  equations.forEach(eq => {
    const pair = eq.split("=");
    if (pair[0] == "table") {
      table = decodeURIComponent(pair[1]);
    }
  });
  return table;
}

// Center the view on the origin of table coordinates,
// using the current canvas size.
function centerViewOn(p: Point) {
  const s = transformation.s;
  transformation.t.x = canvas.width /2 - p.x*s;
  transformation.t.y = canvas.height/2 - p.y*s;
}

function onResize() {
  const oldCenter =
    canvasToTable({x: canvas.width/2, y: canvas.height/2});
  setCanvasResolution();
  centerViewOn(oldCenter);
  repaint();
}

function setCanvasResolution() {
  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
}

function repaint() {
  const myPlayerAreas =
    items.filter(item => item.isPlayerArea == myPlayerId);
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  applyViewTransformation();
  items.forEach(item => drawItem(item, myPlayerAreas));
  if (lastSyncEvent != "received") {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.strokeStyle = "#8088";
    context.lineWidth = 40;
    context.strokeRect(0, 0, canvas.width, canvas.height);
  }
}

function applyViewTransformation() {
  context.translate(transformation.t.x, transformation.t.y);
  context.scale(transformation.s, transformation.s);
}

// input handling

function onMouseDown(e: MouseEvent) {
  const pos = canvasToTable(eventCoordinates(e));
  if (e.buttons == 1) {
    lastDragPos = copyPoint(pos);
    let item = itemAt(pos);
    if (item != null && item.locked) {
      item = null;
    }
    if (item == null) {
      dragging = "table";
      if (!e.shiftKey) {
        deselectAll();
      }
    }
    else {
      if (e.shiftKey) {
        toggleSelected(item);
      }
      else {
        dragging = "items";
        if (!isSelected(item)) {
          deselectAll();
          setSelected(item, true);
        }
      }
    }
    repaint();
  }
  else {
    finishDrag();
  }
}
function onDblClick(e: MouseEvent) {
  const pos = canvasToTable(eventCoordinates(e));
  const item = itemAt(pos);
  if (item !== null) {
    toggleLocked(item);
  }
}
function onMouseMove(e: MouseEvent) {
  const pos = canvasToTable(eventCoordinates(e));
  if (lastDragPos != null) {
    const dx = pos.x - lastDragPos.x;
    const dy = pos.y - lastDragPos.y;
    if (dragging == "items") {
      const selected = selectedItems();
      selected.forEach(moveItem(dx, dy));
      if (selected.length > 0) {
        itemsHaveBeenDragged = true;
      }
      repaint();
    }
    if (dragging == "table") {
      transformation.t.x += transformation.s * dx;
      transformation.t.y += transformation.s * dy;
      repaint();
    }
  }
  lastDragPos = canvasToTable(eventCoordinates(e));
}
function onMouseOut(e: MouseEvent) {
  finishDrag();
}
function onMouseUp(e: MouseEvent) {
  if (e.buttons!=1) {
    finishDrag();
  }
}
function onWheel(e: WheelEvent) {
  e.preventDefault();
  const pos = canvasToTable(eventCoordinates(e));
  const delta = wheelEventDelta(e);
  const factor = Math.pow(scaleSensitivity, -delta);
  if (e.shiftKey) {
    selectedItems().forEach(scaleItem(factor));
    sendSyncData();
    repaint();
  }
  else {
    onScale(factor, pos);
  }
}
function wheelEventDelta(e: WheelEvent): number {
  // TODO:
  // How to interpret e.deltaY (using e.deltaMode) in a sensible way,
  // and still scale items in predefined discrete steps (for piling)?
  return e.deltaY > 0 ? 3 : -3;
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key=="h") {
    window.open("help.txt");
  }
  if (e.key=="c") {
    cloneSelected();
  }
  if (e.key=="Delete" || e.key=="Backspace") {
    deleteSelected();
  }
  if (e.key=="f") {
    flipSelected();
  }
  if (e.key=="s") {
    shuffleSelected();
  }
  if (e.key=="m") {
    claimPlayerArea();
  }
  if (e.key=="a") {
    toggleNewItemDiv();
  }
}

// convert page coordinates of an event to
// canvas-relative coordinates
function eventCoordinates(e: MouseEvent): Point {
  const pos =
    { x: e.pageX - canvas.offsetLeft
    , y: e.pageY - canvas.offsetTop };
  return pos;
}

// convert between canvas and table coordinates
function canvasToTable(p: Point): Point {
  const t = transformation;
  return { x: (p.x-t.t.x)/t.s
         , y: (p.y-t.t.y)/t.s };
}
function tableToCanvas(p: Point): Point {
  const t = transformation;
  return { x: p.x*t.s + t.t.x
         , y: p.y*t.s + t.t.y };
}

function finishDrag() {
  if (dragging == "items") {
    console.log("finishing item drag");
    const selected = selectedItems();
    if (selected.length == 1) {
      if (potentiallyPutOnPile(selected[0])) {
        console.log("(put on pile)");
      }
    }
    sendSyncData();
    repaint();
  }
  dragging = null;
  itemsHaveBeenDragged = false;
}

// scale the view by a factor
// with a fixed reference point (in table coordinates)
function onScale(factor: number, ref: Point) {
  const olds = transformation.s;
  transformation.s *= factor;
  const news = transformation.s;
  transformation.t.x += ref.x * (olds-news);
  transformation.t.y += ref.y * (olds-news);
  repaint();
}

// add an image to the dictionary and load its data
function addImage(url: string) {
  const image = new Image();
  const itemImage = {image: image, loaded: false};
  image.onload = () => {
    console.log("loaded image");
    itemImage.loaded = true;
    sortItems();
    repaint();
  }
  image.src = url;
  images.set(url, itemImage);
}

// add image if missing
function ensureItemImage(item: Item) {
  if (!images.has(item.imgurl)) {
    addImage(item.imgurl);
  }
}

function isItemIdFree(id: ItemId): boolean {
  let free = true;
  items.forEach(item => {if (item.id === id) free = false;});
  return free;
}

function newItemId(): ItemId {
  let id = Math.floor(Math.random()*1000000);
  while (!isItemIdFree(id)) {
    id ++;
  }

  return id;
}

// add item to items array (and also return it)
function addItem(imgurl: string, center: Point, scale: number): Item {
  const id = newItemId();

  const item: Item =
    { id: id
    , imgurl: imgurl
    , center: copyPoint(center)
    , scale: scale
    , locked: false
    , faceDown: false
    , isPlayerArea: null
    };
  items.push(item);
  ensureItemImage(item);
  sortItems();
  return item;
}

// image of an item or null (if not yet loaded)
function itemImage(item: Item): HTMLImageElement | null {
  const img = images.get(item.imgurl);
  if (img === undefined) {
    return null;
  }
  if (img.loaded == true) {
    return img.image;
  }
  else {
    return null;
  }
}

function itemSize(item: Item): Size {
  const img = itemImage(item);
  const s = item.scale;
  if (img != null) {
    return {w: img.width*s, h: img.height*s};
  }
  else {
    // default size
    return {w: 50*s, h: 50*s}
  }
}

// a number representing the size of the item
// (for sorting by size)
function itemSizeMeasure(item: Item): number {
  // Use rounded size to respect piling compatibility
  // and sort by x coordinate for equal size.
  const size = roundedItemSize(item);
  return size.w * size.h - 0.0001 * item.center.x;
}

function drawItem(item: Item, myPlayerAreas: Item[]) {
  const img = itemImage(item);
  const size = itemSize(item);
  const pos = { x: item.center.x - size.w/2
              , y: item.center.y - size.h/2 };
  if (!item.faceDown) {
    drawItemFaceUp(img, pos, size);
  }
  else {
    let transparent = false;
    myPlayerAreas.forEach(area => {
      if (itemIsContainedIn(item, area)) {
        transparent = true;
      }
    });
    if (transparent) {
      drawItemFaceUp(img, pos, size);
      drawFaceDownReminder(pos, size);
    }
    else {
      drawItemFaceDown(pos, size);
    }
  }
  if (isSelected(item)) {
    drawSelectionBorder(pos, size);
  }
  if (item.isPlayerArea != null) {
    drawPlayerAreaBorder(item, pos, size);
  }
  if (item.locked) {
    drawLockedItemBorder(item.center, size);
  }
}

function drawItemFaceUp(img: HTMLImageElement | null, pos: Point, size: Size) {
  if (img !== null) {
    context.drawImage(img, pos.x, pos.y, size.w, size.h);
  }
  else {
    context.fillStyle = "grey";
    context.fillRect(pos.x, pos.y, size.w, size.h);
  }
}

function drawItemFaceDown(pos: Point, size: Size) {
  context.fillStyle = "black";
  context.fillRect(pos.x, pos.y, size.w, size.h);
  context.lineWidth = 1;
  context.strokeStyle = "grey";
  context.strokeRect(pos.x, pos.y, size.w, size.h);
}

function drawFaceDownReminder(pos: Point, size: Size) {
  context.fillStyle = "#0002";
  context.fillRect(pos.x, pos.y, size.w, size.h);

  function strokeInnerFrame(color: string, b: number) {
    context.strokeStyle = color;
    context.lineWidth = b;
    context.strokeRect(pos.x+b/2, pos.y+b/2, size.w-b, size.h-b);
  }
  strokeInnerFrame("#000c", 5);

  context.lineWidth = 1;
  context.strokeStyle = "black";
  context.strokeRect(pos.x, pos.y, size.w, size.h);
}

function drawSelectionBorder(pos: Point, size: Size) {
  context.lineWidth = 3;
  context.strokeStyle = "#0088";
  context.strokeRect(pos.x-2, pos.y-2, size.w+4, size.h+4);
  context.lineWidth = 2;
  context.strokeStyle = "#0ff";
  context.strokeRect(pos.x-2, pos.y-2, size.w+4, size.h+4);
}

function drawLockedItemBorder(center: Point, size: Size) {
  const l = center.x - size.w/2;
  const r = center.x + size.w/2;
  const t = center.y - size.h/2;
  const b = center.y + size.h/2;
  const stitchWidth = Math.sqrt(20 * Math.sqrt(size.w*size.h)/10);
  drawStitches({x: r, y: t}, {x: l, y: t}, stitchWidth);
  drawStitches({x: l, y: t}, {x: l, y: b}, stitchWidth);
  drawStitches({x: l, y: b}, {x: r, y: b}, stitchWidth);
  drawStitches({x: r, y: b}, {x: r, y: t}, stitchWidth);
}

function drawStitches(start: Point, end: Point, width: number) {
  const wantedSlope = 1.5;
  const wantedPeriod = 2 * width / wantedSlope;
  const d = {x: end.x - start.x, y: end.y - start.y};
  const l = Math.sqrt(d.x**2 + d.y**2);
  const n = Math.round((l-width)/wantedPeriod);
  if (n <= 0) return;
  const period = (l-width)/n;
  const a = {x: d.x/l*period, y: d.y/l*period};
  const b = {x: -d.y/l*width, y: d.x/l*width};

  context.save();
  context.strokeStyle = "#0004";
  context.lineWidth = 1;
  context.translate(start.x + d.x/l*width/2, start.y + d.y/l*width/2);
  for (let i = 0; i < n; i++) {
    context.beginPath();
    context.moveTo( i     *a.x - b.x/2,  i     *a.y - b.y/2);
    context.lineTo((i+0.5)*a.x + b.x/2, (i+0.5)*a.y + b.y/2);
    context.stroke();
  }
  context.restore();
}

// unused
function drawLockedItemBorder_old(center: Point, size: Size) {
  const h = size.h;
  const w = size.w;
  const a = Math.sqrt(size.w * size.h) / 8;

  context.fillStyle = "#0004";
  [-1, 1].forEach(sx => {
    [-1, 1].forEach(sy => {
      context.save();
      context.translate(center.x, center.y);
      context.scale(sx, sy);
      context.translate(w/2, h/2);
      context.scale(a, a);
      fillPolygon([[0.2, 0.2], [-1, 0.2], [0.2, -1]]);
      context.restore();
    });
  });
}

// unused
function fillPolygon(vertices: number[][]) {
  context.beginPath();
  context.moveTo(vertices[0][0], vertices[0][1]);
  for (let i = 1; i < vertices.length; i++) {
    context.lineTo(vertices[i][0], vertices[i][1]);
  }
  context.closePath();
  context.fill();
}

function drawPlayerAreaBorder(item: Item, pos: Point, size: Size) {
  context.lineWidth = 1;
  if (item.isPlayerArea == myPlayerId) {
    context.strokeStyle = "green";
  }
  else {
    context.strokeStyle = "red";
  }
  context.strokeRect(pos.x, pos.y, size.w, size.h);
}

//removes all duplicates by id from items
function removeDuplictes() {
}

// called when new sync data is recieved
function newData(json: string) {
  if (json.length == 0) json = "[]";
  const newItems = JSON.parse(json) as Item[];
  // TODO: check that newItems is an array of items
  lastSyncEvent = "received";
  //if (dragging == "items") {
  //  dragging = null;
  //  itemsHaveBeenDragged = false;
  //}
  // do not accept movement of selected items while dragging
  if (dragging == "items") {
    newItems.forEach(newItem => {
      if (isSelected(newItem)) {
        const oldItem = itemById(newItem.id);
        if (oldItem !== null) {
          newItem.center = oldItem.center;
        }
      }
    })
  }

  newItems.forEach(i => { 
    if (i.id === undefined) {
      i.id = newItemId();
    }
  });
  
  items = newItems;
  items.forEach(ensureItemImage);
  sortItems();
  repaint();
}

// utility function for sorting
function comparing<T>(feature: (element: T) => number): (a: T, b: T) => number {
  return (a, b) => feature(b) - feature(a);
}

// sort item array by size
function sortItems() {
  items.sort(comparing(itemSizeMeasure));
}

function itemById(id: ItemId): Item | null {
  const foundItems = items.filter(i => i.id === id);
  if (foundItems.length == 0)
    return null;
  else
    return foundItems[0];
}

// array of only the currently selected items
function selectedItems(): Item[] {
  return items.filter(isSelected);
}
function notSelectedItems(): Item[] {
  return items.filter(item => !isSelected(item));
}

function moveItem(dx: number, dy: number): (item: Item) => void {
  return item => {
    item.center.x += dx;
    item.center.y += dy;
  };
}
function scaleItem(factor: number): (item: Item) => void {
  return item => item.scale *= factor;
}

// the foremost item covering the given point,
// or null
function itemAt(pos: Point): Item | null {
  // search items from front to back
  for (let i = items.length-1; i>=0; i--) {
    const item = items[i];
    if (itemCovers(item, pos)) {
      return item;
    }
  }
  return null;
}

// does the item contain the point?
function itemCovers(item: Item, pos: Point): boolean {
  const size = itemSize(item);
  const x_rel = pos.x - item.center.x;
  const y_rel = pos.y - item.center.y;
  if ( x_rel < -size.w/2 || x_rel >= size.w/2 ||
       y_rel < -size.h/2 || y_rel >= size.h/2 ) {
    return false;
  }
  // I would like to check the alpha value of the items image now,
  // but this is forbidden for images from other domains...
  return true;
}

function itemIsContainedIn(inner: Item, outer: Item): boolean {
  const s0 = itemSize(inner);
  const s1 = itemSize(outer);
  const dx = inner.center.x - outer.center.x;
  const dy = inner.center.y - outer.center.y;
  const dw = s1.w - s0.w;
  const dh = s1.h - s0.h;
  return ( dx > -dw/2 && dx < dw/2 && dy > -dh/2 && dy < dh/2 );
}

// selecting items

function deselectAll() {
  selectedItemIds = [];
}

function setSelected(item: Item, value: boolean) {
  if (item == null || item.locked) return;
  // Items in piles select and deselect together,
  // except for the topmost one.
  if (isNonTopPileMember(item)) {
    if (value) {
      wholePile(item).forEach(i => selectedItemIds.push(i.id));
    }
    else {
      const pileIds = wholePile(item).map(i => i.id);
      selectedItemIds = selectedItemIds.filter(i => !pileIds.includes(i));
    }
  }
  else {
    if (value) {
      selectedItemIds.push(item.id);
    }
    else {
      selectedItemIds = selectedItemIds.filter(i => i !== item.id);
    }
  }
}

function isSelected(item: Item): boolean {
  return selectedItemIds.includes(item.id);
}

function toggleSelected(item: Item) {
  if (isSelected(item)) {
    setSelected(item, false);
  }
  else {
    setSelected(item, true);
  }
}

function toggleLocked(item: Item) {
  if (item == null) return;
  if (item.locked) {
    item.locked = false;
    item.isPlayerArea = null;
    setSelected(item, true);
  }
  else {
    setSelected(item, false);
    item.locked = true;
  }
  sendSyncData();
  repaint();
}

function cloneItem(item: Item): Item {
  const clone = addItem(
      item.imgurl
    , {x: item.center.x + 20, y: item.center.y + 20}
    , item.scale );
  return clone;
}

function cloneSelected() {
  const clones: Item[] = [];
  selectedItems().forEach(item => {
    setSelected(item, false);
    clones.push(cloneItem(item));
  });
  clones.forEach(item => setSelected(item, true));
  sendSyncData();
  repaint();
}

function deleteSelected() {
  items = notSelectedItems();
  sendSyncData();
  repaint();
}

function flipSelected() {
  let allFaceDown = true;
  selectedItems().forEach(item => {
    allFaceDown = allFaceDown && item.faceDown;
  });
  selectedItems().forEach(item => {
    item.faceDown = !allFaceDown;
  });
  sendSyncData();
  repaint();
}

function maximumByComparing<T>(feature: (element: T) => number, array: T[]): T | null {
  const result = array.reduce<{score: number | null, leader: T | null}>(
    (acc, x) => {
      const score = feature(x);
      if (acc.score === null || feature(x) > acc.score) {
        return {score: score, leader: x};
      }
      else {
        return acc;
      }
    },
    {score: null, leader: null});
  return result.leader;
}

function shuffleSelected() {
  const selected = selectedItems();
  if (selected.length == 0) return;
  // Only proceed if all selected items have the same rounded size.
  const size = roundedItemSize(selected[0]);
  let allSameSize = true;
  selected.forEach(i => {
    if (!hasRoundedSize(size, i)) allSameSize = false;
  });
  if (!allSameSize) return;
  // Determine the position of the shuffled pile.
  const selectedBottoms =
    selected.filter(i => findPileNeighbour(i, -1) === null);
  const bottomOfLargestPile =
    maximumByComparing(i => wholePile(i).length, selectedBottoms);
  let pos = null;
  if (bottomOfLargestPile === null) {
    pos = copyPoint(selected[0].center);
  }
  else {
    pos = copyPoint(bottomOfLargestPile.center);
  }
  // Shuffle and arrange.
  shuffleArray(selected);
  arrangeShuffledPile(selected, pos, size);
  deselectAll();
  sortItems();
  sendSyncData();
  repaint();
}

// // unused
// function arrayIncludes(a, e) {
//   let result = false;
//   a.forEach(x => {
//     if (x == e) {
//       result = true;
//     }
//   });
//   return result;
// }

// Fischer-Yates-shuffle
function shuffleArray<T>(a: T[]) {
  for (let i = a.length-1; i>=0; i--) {
    const j = Math.floor(Math.random() * (i+1));
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
}

function claimPlayerArea() {
  const selected = selectedItems();
  if (selected.length == 1) {
    setSelected(selected[0], false);
    selected[0].locked = true;
    selected[0].isPlayerArea = myPlayerId;
  }
  sendSyncData();
  repaint();
}

// piling related stuff

function roundedItemSize(item: Item) {
  const s0 = itemSize(item);
  return {w: Math.round(s0.w), h: Math.round(s0.h)};
}

// Two items can only go on the same pile
// if they have the same rounded size.
function hasRoundedSize(roundedSize: Size, item: Item): boolean {
  const s0 = roundedSize;
  const s1 = roundedItemSize(item);
  return s0.w == s1.w && s0.h == s1.h;
}

type OneDimDirection = -1 | 1;

function expectedPileNeighbourPosition(item: Item, d: OneDimDirection): Point {
  const size = roundedItemSize(item)
  const dx = size.w * 0.25 * d;
  const dy = 0;
  return {x: item.center.x + dx, y: item.center.y + dy};
}

function isPileNeighbour(item: Item, d: OneDimDirection, tolerance: number): (other: Item) => boolean {
  const size = roundedItemSize(item);
  const expected = expectedPileNeighbourPosition(item, d);
  return other => {
    const c0 = item != other;
    const c1 = hasRoundedSize(size, other);
    const c2 = Math.abs(other.center.x - expected.x) < size.w * tolerance;
    const c3 = Math.abs(other.center.y - expected.y) < size.h * tolerance;
    const c4 = other.locked == false;
    // console.log("-- " + c0 + " " + c1 + " " + c2 + " " + c3);
    return c0 && c1 && c2 && c3 && c4;
  }
}

// Find left (d=-1) or right (d=1) neighbour in a pile.
// TODO: handle all lines longer than 72 characters :-)
function findPileNeighbour(item: Item, d: OneDimDirection, tolerance=0.01): Item | null {
  const neighs = items.filter(isPileNeighbour(item, d, tolerance));
  if (neighs.length == 0) {
    return null;
  }
  else {
    return neighs[0];
  }
}

function potentiallyPutOnPile(item: Item): boolean {
  const found = findPileNeighbour(item, -1, 0.25);
  if (found == null) {
    return false;
  }
  // Temporarily lock the item, so it does not count for the pile.
  // (Sorry for that.)
  item.locked = true;
  const topmost = topOfPile(found);
  item.locked = false;
  item.center = expectedPileNeighbourPosition(topmost, 1);
  return true;
}

// Apply funciton f to the items in a pile,
// starting at the given item, going in direction d.
function traversePile(item: Item, d: OneDimDirection, f: (i: Item) => void) {
  let i: Item | null = item;
  while (i !== null) {
    f(i);
    i = findPileNeighbour(i, d);
  }
}

function endOfPile(item: Item, d: OneDimDirection): Item {
  let result = item;
  traversePile(item, d, i => result = i);
  return result;
}

function topOfPile(item: Item): Item {
  return endOfPile(item, 1);
}

function bottomOfPile(item: Item): Item {
  return endOfPile(item, -1);
}

function wholePile(item: Item): Item[] {
  const bottom = bottomOfPile(item);
  const pile: Item[] = [];
  traversePile(bottom, 1, i => pile.push(i));
  return pile;
}

function isNonTopPileMember(item: Item): boolean {
  return findPileNeighbour(item, 1) != null;
}

function arrangeShuffledPile(pileItems: Item[], centerOfBottom: Point, size: Size) {
  let center = copyPoint(centerOfBottom);
  center.y += 0.5 * size.h;
  for (let i = 0; i < pileItems.length; i++) {
    // center.x += 0.1 * (Math.random()-0.5) * size.w;
    // center.y += 0.1 * (Math.random()-0.5) * size.h;
    pileItems[i].center.x = center.x;
    pileItems[i].center.y = center.y;
    center = expectedPileNeighbourPosition(pileItems[i], 1);
  }
}


// hide or show new item line
function toggleNewItemDiv(on?: boolean) {
  if (on === undefined) {
    on = ui.newItemDiv.style.display === "none";
  }
  ui.newItemDiv.style.display = on ? "flex" : "none";
  if (on === true) {
    // give url field the focus,
    // but do not let the current event propagate to it
    setTimeout(() => ui.newItemText.focus(), 1);
  }
}

// user clicked add new item button
function onAddNewItem() {
  const imgurl = ui.newItemText.value;
  ui.newItemText.value = "";
  toggleNewItemDiv(false);
  addItem(imgurl, {x: 0, y: 0}, 1);
  canvas.focus();
  sendSyncData();
  repaint();
}

function sendSyncData() {
  lastSyncEvent = "sent";
  if (socket != null) {
    socket.send(JSON.stringify(items));
  }
}

function tryConnect() {
  if (socket != null) {
    disconnect();
  }
  const url = domain + "/table-" + ui.tableNameText.value;
  socket = new WebSocket(url);
  socket.onclose = disconnect;
  socket.onerror = disconnect;
  socket.onopen = onConnected;
  socket.onmessage = onMessage;
}

function onMessage(e: MessageEvent) {
  // read json string from the blob e.data
  const reader = new FileReader();
  reader.onload = () => {
    if (typeof reader.result !== "string") return;
    newData(reader.result);
  };
  reader.onerror = () => console.log("error reading received blob");
  reader.readAsText(e.data);
}

function onConnected() {
  ui.notConnectedLabel.style.display = "none";
  ui.tableNameButton.disabled = true;
}

function disconnect() {
  if (socket != null && (isConnecting(socket) || isOpen(socket))) {
    socket.close();
  }
  discardSocket();
  ui.notConnectedLabel.style.display = "block";
  ui.tableNameButton.disabled = false;
}

function isConnecting(socket: WebSocket): boolean {
  return socket.readyState == WebSocket.CONNECTING;
}
function isOpen(socket: WebSocket) {
  return socket.readyState == WebSocket.OPEN;
}

function discardSocket() {
  if (socket == null) return;
  socket.onmessage = null;
  socket.onopen = null;
  socket.onclose = null;
  socket.onerror = null;
  socket = null;
}

function copyPoint(p: Point): Point {
  return {x: p.x, y: p.y};
}
