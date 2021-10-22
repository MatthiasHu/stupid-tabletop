"use strict";

// address for stupid-sync connection
const domain = "wss://schwubbl.de/stupid-sync-entry";

const scaleSensitivity = 1.05;

// canvas element and drawing context
let canvas;
let context;

// UI elements
const ui =
  { body: null
  , tableNameText: null
  , tableNameButton: null
  , newItemDiv: null
  , newItemText: null
  , newItemButton: null
  , notConnectedLabel: null
  }

//list of items selected for drag&drop
let selectedItemIds = [];


// the data to be synced: an array of items
let items = [];
// each item must be of the form
// { 
// id: an auto-generated number
// , imgurl: <a string>
// , center: {x: ..., y: ...}
// , scale: ...
// , locked: <a bool>
// , faceDown: <a bool>
// , isPlayerArea: <null or a player id>
// }
// center is in table coordinates.
// locked == true implies selected == false.
// TODO: there is no selected.
// locked == false implies isPlayerArea == null.

// image data,
// dictionary from urls to image objects
// (each image object gets an extra "loaded" attribute when loaded)
const images = {};

// last known mouse position as {x: ..., y: ...}
// (in table coordinates)
// or null (if mouse is not pressed or outside the canvas)
let lastDragPos = null;

// null, "items" or "table".
// Set on mouse down event.
let dragging = null;

// Send sync data on mouse up?
// (Implies dragging == "items".)
let itemsHaveBeenDragged = false;

// Has data last been sent or received?
// ("sent" or "received" or null.)
let lastSyncEvent = null;

// current view transformation (translation and scale)
let transformation = {t: {x: 0, y: 0}, s: 1};
// [table coords] ---(scaling)---(translation)--- [canvas coords]

// the websocket
let socket = null;
// null when there is no current connection or conntection attempt

// Randomly generated identifier for this player.
const myPlayerId = "player" + Math.floor(Math.random()*1000000);


function onLoad() {
  const get = id => document.getElementById(id);

  canvas = get("bigcanvas");
  context = canvas.getContext("2d");

  ui.body = get("body");
  ui.tableNameText = get("table-name-text");
  ui.tableNameButton = get("table-name-button");
  ui.newItemDiv = get("new-item-div");
  ui.newItemText = get("new-item-text");
  ui.newItemButton = get("new-item-button");
  ui.notConnectedLabel = get("not-connected-label");

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

function tableNameFromURL() {
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
function centerViewOn(p) {
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

function onMouseDown(e) {
  const pos = canvasToTable(eventCoordinates(e));
  if (e.buttons==1) {
    lastDragPos = copyPoint(pos);
    let item = itemAt(pos.x, pos.y);
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
function onDblClick(e) {
  const pos = canvasToTable(eventCoordinates(e));
  const item = itemAt(pos.x, pos.y);
  toggleLocked(item);
}
function onMouseMove(e) {
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
function onMouseOut(e) {
  finishDrag();
}
function onMouseUp(e) {
  if (e.buttons!=1) {
    finishDrag();
  }
}
function onWheel(e) {
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
function wheelEventDelta(e) {
  // TODO:
  // How to interpret e.deltaY (using e.deltaMode) in a sensible way,
  // and still scale items in predefined discrete steps (for piling)?
  return e.deltaY > 0 ? 3 : -3;
}

function onKeyDown(e) {
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
function eventCoordinates(e) {
  const pos =
    { x: e.pageX - canvas.offsetLeft
    , y: e.pageY - canvas.offsetTop };
  return pos;
}

// convert between canvas and table coordinates
function canvasToTable(p) {
  const t = transformation;
  return { x: (p.x-t.t.x)/t.s
         , y: (p.y-t.t.y)/t.s };
}
function tableToCanvas(p) {
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
function onScale(factor, ref) {
  const olds = transformation.s;
  transformation.s *= factor;
  const news = transformation.s;
  transformation.t.x += ref.x * (olds-news);
  transformation.t.y += ref.y * (olds-news);
  repaint();
}

// add an image to the dictionary and load its data
function addImage(url) {
  const img = new Image();
  img.onload = () => {
    console.log("loaded image");
    img.loaded = true;
    sortItems();
    repaint();
  }
  img.src = url;
  images[url] = img;
}

// add image if missing
function ensureItemImage(item) {
  if (images[item.imgurl] == null) {
    addImage(item.imgurl);
  }
}

function isItemIdFree(id) {
  let free = true;
  items.forEach(item => {if (item.id === id) free = false;});
  return free;
}

function newItemId() {
  let id = Math.floor(Math.random()*1000000);
  while (!isItemIdFree(id)) {
    id ++;
  }

  return id;
}

// add item to items array (and also return it)
function addItem(imgurl, center, scale) {
  const id = newItemId();

  const item =
    { id: id
    , imgurl: imgurl
    , center: copyPoint(center)
    , scale: scale
    , selected: false
    , locked: false
    , faceDown: false };
  items.push(item);
  ensureItemImage(item);
  sortItems();
  return item;
}

// image of an item or null (if not yet loaded)
function itemImage(item) {
  const img = images[item.imgurl];
  if (img.loaded == true) {
    return img;
  }
  else {
    return null;
  }
}

// size of an item as {w: ..., h: ...}
function itemSize(item) {
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
function itemSizeMeasure(item) {
  // Use rounded size to respect piling compatibility
  // and sort by x coordinate for equal size.
  const size = roundedItemSize(item);
  return size.w * size.h - 0.0001 * item.center.x;
}

function drawItem(item, myPlayerAreas) {
  const img = itemImage(item);
  const size = itemSize(item);
  const x = item.center.x - size.w/2;
  const y = item.center.y - size.h/2;
  if (!item.faceDown) {
    drawItemFaceUp(img, x, y, size);
  }
  else {
    let transparent = false;
    myPlayerAreas.forEach(area => {
      if (itemIsContainedIn(item, area)) {
        transparent = true;
      }
    });
    if (transparent) {
      drawItemFaceUp(img, x, y, size);
      drawFaceDownReminder(x, y, size);
    }
    else {
      drawItemFaceDown(x, y, size);
    }
  }
  if (isSelected(item)) {
    drawSelectionBorder(x, y, size);
  }
  if (item.isPlayerArea != null) {
    drawPlayerAreaBorder(item, x, y, size);
  }
  if (item.locked) {
    drawLockedItemBorder(item.center, size);
  }
}

function drawItemFaceUp(img, x, y, size) {
  if (img != null) {
    context.drawImage(img, x, y, size.w, size.h);
  }
  else {
    context.fillStyle = "grey";
    context.fillRect(x, y, size.w, size.h);
  }
}

function drawItemFaceDown(x, y, size) {
  context.fillStyle = "black";
  context.fillRect(x, y, size.w, size.h);
  context.lineWidth = 1;
  context.strokeStyle = "grey";
  context.strokeRect(x, y, size.w, size.h);
}

function drawFaceDownReminder(x, y, size) {
  context.fillStyle = "#0002";
  context.fillRect(x, y, size.w, size.h);

  function strokeInnerFrame(color, b) {
    context.strokeStyle = color;
    context.lineWidth = b;
    context.strokeRect(x+b/2, y+b/2, size.w-b, size.h-b);
  }
  strokeInnerFrame("#000c", 5);

  context.lineWidth = 1;
  context.strokeStyle = "black";
  context.strokeRect(x, y, size.w, size.h);
}

function drawSelectionBorder(x, y, size) {
  context.lineWidth = 3;
  context.strokeStyle = "#0088";
  context.strokeRect(x-2, y-2, size.w+4, size.h+4);
  context.lineWidth = 2;
  context.strokeStyle = "#0ff";
  context.strokeRect(x-2, y-2, size.w+4, size.h+4);
}

function drawLockedItemBorder(center, size) {
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

function drawStitches(start, end, width) {
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
function drawLockedItemBorder_old(cx, cy, size) {
  const h = size.h;
  const w = size.w;
  const a = Math.sqrt(size.w * size.h) / 8;

  context.fillStyle = "#0004";
  [-1, 1].forEach(sx => {
    [-1, 1].forEach(sy => {
      context.save();
      context.translate(cx, cy);
      context.scale(sx, sy);
      context.translate(w/2, h/2);
      context.scale(a, a);
      fillPolygon(context, [[0.2, 0.2], [-1, 0.2], [0.2, -1]]);
      context.restore();
    });
  });
}

// unused
function fillPolygon(context, vertices) {
  context.beginPath();
  context.moveTo(vertices[0][0], vertices[0][1]);
  for (let i = 1; i < vertices.length; i++) {
    context.lineTo(vertices[i][0], vertices[i][1]);
  }
  context.closePath();
  context.fill();
}

function drawPlayerAreaBorder(item, x, y, size) {
  context.lineWidth = 1;
  if (item.isPlayerArea == myPlayerId) {
    context.strokeStyle = "green";
  }
  else {
    context.strokeStyle = "red";
  }
  context.strokeRect(x, y, size.w, size.h);
}

//removes all duplicates by id from items
function removeDuplictes() {
}

// called when new sync data is recieved
function newData(json) {
  if (json.length == 0) json = "[]";
  const newItems = JSON.parse(json);
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
        newItem.center = itemById(newItem.id).center;
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
function comparing(feature) {
  return (a, b) => feature(b) - feature(a);
}

// sort item array by size
function sortItems() {
  items.sort(comparing(itemSizeMeasure));
}

function itemById(id) {
  const foundItems = items.filter(i => i.id === id);
  if (foundItems === [])
    return {}
  else
    return foundItems[0];
}

// array of only the currently selected items
function selectedItems() {
  return items.filter(isSelected);
}
function notSelectedItems() {
  return items.filter(item => !isSelected(item));
}

function moveItem(dx, dy) {
  return item => {
    item.center.x += dx;
    item.center.y += dy;
  };
}
function scaleItem(factor) {
  return item => item.scale *= factor;
}

// the foremost item covering the given point,
// or null
function itemAt(x, y) {
  // search items from front to back
  for (let i = items.length-1; i>=0; i--) {
    const item = items[i];
    if (itemCovers(item, x, y)) {
      return item;
    }
  }
  return null;
}

// does the item contain the point?
function itemCovers(item, x, y) {
  const size = itemSize(item);
  const x_rel = x - item.center.x;
  const y_rel = y - item.center.y;
  if ( x_rel < -size.w/2 || x_rel >= size.w/2 ||
       y_rel < -size.h/2 || y_rel >= size.h/2 ) {
    return false;
  }
  // I would like to check the alpha value of the items image now,
  // but this is forbidden for images from other domains...
  return true;
}

function itemIsContainedIn(inner, outer) {
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

function setSelected(item, value) {
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

function isSelected(item)
{
  return selectedItemIds.includes(item.id);
}

function toggleSelected(item) {
  if (isSelected(item)) {
    setSelected(item, false);
  }
  else {
    setSelected(item, true);
  }
}

function toggleLocked(item) {
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

function cloneItem(item) {
  const clone = addItem(
      item.imgurl
    , {x: item.center.x + 20, y: item.center.y + 20}
    , item.scale );
  return clone;
}

function cloneSelected() {
  const clones = [];
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
  let bottomOfLargestPile = null;
  let sizeOfLargestPile = 0;
  selected.forEach(i => {
    if (findPileNeighbour(i, 0) != null) return;
    const s = wholePile(i).length;
    if (s > sizeOfLargestPile) {
      bottomOfLargestPile = i;
      sizeOfLargestPile = s;
    }
  });
  let pos = null;
  if (bottomOfLargestPile == null) {
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

function arrayIncludes(a, e) {
  let result = false;
  a.forEach(x => {
    if (x == e) {
      result = true;
    }
  });
  return result;
}

// Fischer-Yates-shuffle
function shuffleArray(a) {
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

function roundedItemSize(item) {
  const s0 = itemSize(item);
  return {w: Math.round(s0.w), h: Math.round(s0.h)};
}

// Two items can only go on the same pile
// if they have the same rounded size.
function hasRoundedSize(roundedSize, item) {
  const s0 = roundedSize;
  const s1 = roundedItemSize(item);
  return s0.w == s1.w && s0.h == s1.h;
}

function expectedPileNeighbourPosition(item, d) {
  const size = roundedItemSize(item)
  const dx = size.w * 0.25 * d;
  const dy = 0;
  return {x: item.center.x + dx, y: item.center.y + dy};
}

function isPileNeighbour(item, d, tolerance) {
  const size = roundedItemSize(item)
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
function findPileNeighbour(item, d, tolerance=0.01) {
  const neighs = items.filter(isPileNeighbour(item, d, tolerance));
  if (neighs.length == 0) {
    return null;
  }
  else {
    return neighs[0];
  }
}

function potentiallyPutOnPile(item) {
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
function traversePile(item, d, f) {
  let i = item;
  while (i != null) {
    f(i);
    i = findPileNeighbour(i, d);
  }
}

function endOfPile(item, d) {
  let result = null;
  traversePile(item, d, i => result = i);
  return result;
}

function topOfPile(item) {
  return endOfPile(item, 1);
}

function bottomOfPile(item) {
  return endOfPile(item, -1);
}

function wholePile(item) {
  const bottom = bottomOfPile(item);
  const pile = [];
  traversePile(bottom, 1, i => pile.push(i));
  return pile;
}

function isNonTopPileMember(item) {
  return findPileNeighbour(item, 1) != null;
}

function arrangeShuffledPile(pileItems, centerOfBottom, size) {
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
function toggleNewItemDiv(on) {
  if (on==null) {
    on = ui.newItemDiv.style.display == "none";
  }
  ui.newItemDiv.style.display = (on ? "flex" : "none");
  if (on==true) {
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

function onMessage(e) {
  // read json string from the blob e.data
  const reader = new FileReader();
  reader.onload = () => newData(reader.result);
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

function isConnecting(socket) {
  return socket.readySttate == WebSocket.CONNECTING;
}
function isOpen(socket) {
  return socket.readySttate == WebSocket.OPEN;
}

function discardSocket() {
  if (socket == null) return;
  socket.onmessage = null;
  socket.onopen = null;
  socket.onclose = null;
  socket.onerror = null;
  socket = null;
}

function copyPoint(p) {
  return {x: p.x, y: p.y};
}
