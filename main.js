"use strict";

// address for stupid-sync connection
var domain = "wss://monus.de/stupid-sync-entry";

var scaleSensibility = 1.05;

// canvas element and drawing context
var canvas;
var context;

// UI elements
var ui =
  { body: null
  , tableNameText: null
  , tableNameButton: null
  , newItemDiv: null
  , newItemText: null
  , newItemButton: null
  , notConnectedLabel: null
  }

// the data to be synced: an array of items
var items = [];
// each item must be of the form
// { imgurl: <a string>
// , center: {x: ..., y: ...}
// , scale: ...
// , selected: <a bool>
// , locked: <a bool>
// , faceDown: <a bool>
// , isPlayerArea: <null or a player id>
// }
// center is in table coordinates.
// locked == true implies selected == false.
// locked == false implies isPlayerArea == null.

// image data,
// dictionary from urls to image objects
// (each image object gets an extra "loaded" attribute when loaded)
var images = {};

// last known mouse position as {x: ..., y: ...}
// (in table coordinates)
// or null (if mouse is not pressed or outside the canvas)
var lastDragPos = null;

// are some items currently being dragged?
// (then send sync data on mouse up)
var dragging = false;

// current view transformation (translation and scale)
var transformation = {t: {x: 0, y: 0}, s: 1};
// [table coords] ---(scaling)---(translation)--- [canvas coords]

// the websocket
var socket = null;
// null when there is no current connection or conntection attempt

// Randomly generated identifier for this player.
var playerId = "player" + Math.floor(Math.random()*1000000);


function onLoad() {
  var get = function(id) {return document.getElementById(id);};

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
  var table = "default";
  var equations = window.location.search.substring(1).split("&");
  equations.forEach(function(eq) {
    var pair = eq.split("=");
    if (pair[0] == "table") {
      table = decodeURIComponent(pair[1]);
    }
  });
  return table;
}

// Center the view on the origin of table coordinates,
// using the current canvas size.
function centerViewOn(p) {
  var s = transformation.s;
  transformation.t.x = canvas.width /2 - p.x*s;
  transformation.t.y = canvas.height/2 - p.y*s;
}

function onResize() {
  var oldCenter =
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
  var myPlayerAreas = items.filter(function(item) {
    return item.isPlayerArea == playerId;
  });
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  applyViewTransformation();
  items.forEach(function(item) {
    drawItem(item, myPlayerAreas);
  });
}
function applyViewTransformation() {
  context.translate(transformation.t.x, transformation.t.y);
  context.scale(transformation.s, transformation.s);
}

// input handling

function onMouseDown(e) {
  var pos = canvasToTable(eventCoordinates(e));
  if (e.buttons==1) {
    lastDragPos = {x: pos.x, y: pos.y};
    var item = itemAt(pos.x, pos.y);
    if (item != null && item.locked == true) {
      item = null;
    }
    if (!e.shiftKey) {
      if (item == null || item.selected != true) {
        deselectAll();
        setSelected(item, true);
      }
    }
    else {
      toggleSelected(item);
    }
    repaint();
  }
  else {
    finishDrag();
  }
}
function onDblClick(e) {
  var pos = canvasToTable(eventCoordinates(e));
  var item = itemAt(pos.x, pos.y);
  toggleLocked(item);
}
function onMouseMove(e) {
  var pos = canvasToTable(eventCoordinates(e));
  if (e.buttons==1) {
    if (lastDragPos != null) {
      var selected = selectedItems();
      if (selected.length > 0) {
        dragging = true;
        var dx = pos.x - lastDragPos.x;
        var dy = pos.y - lastDragPos.y;
        selected.forEach(moveItem(dx, dy));
      }
      repaint();
    }
    lastDragPos = {x: pos.x, y: pos.y};
  }
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
  var pos = canvasToTable(eventCoordinates(e));
  var factor = Math.pow(scaleSensibility, -e.deltaY);
  if (e.shiftKey) {
    selectedItems().forEach(scaleItem(factor));
    repaint();
    sendSyncData();
  }
  else {
    onScale(factor, pos);
  }
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
  var pos =
    { x: e.pageX - canvas.offsetLeft
    , y: e.pageY - canvas.offsetTop };
  return pos;
}

// convert between canvas and table coordinates
function canvasToTable(p) {
  var t = transformation;
  return { x: (p.x-t.t.x)/t.s
         , y: (p.y-t.t.y)/t.s };
}
function tableToCanvas(p) {
  var t = transformation;
  return { x: p.x*t.s + t.t.x
         , y: p.y*t.s + t.t.y };
}

function finishDrag() {
  if (dragging != true) {
    return;
  }
  console.log("finishing drag");
  dragging = false;
  var selected = selectedItems();
  if (selected.length == 1) {
    if (potentiallyPutOnPile(selected[0])) {
      console.log("(put on pile)");
    }
  }
  repaint();
  sendSyncData();
}

// scale the view by a factor
// with a fixed reference point (in table coordinates)
function onScale(factor, ref) {
  var olds = transformation.s;
  transformation.s *= factor;
  var news = transformation.s;
  transformation.t.x += ref.x * (olds-news);
  transformation.t.y += ref.y * (olds-news);
  repaint();
}

// add an image to the dictionary and load it's data
function addImage(url) {
  var img = new Image();
  img.onload = function() {
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

// add item to items array (and also return it)
function addItem(imgurl, center, scale) {
  var item =
    { imgurl: imgurl
    , center: {x: center.x, y: center.y}
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
  var img = images[item.imgurl];
  if (img.loaded == true) {
    return img;
  }
  else {
    return null;
  }
}

// size of an item as {w: ..., h: ...}
function itemSize(item) {
  var img = itemImage(item);
  var s = item.scale;
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
  var size = roundedItemSize(item);
  return size.w * size.h - 0.0001 * item.center.x;
}

function drawItem(item, myPlayerAreas) {
  var img = itemImage(item);
  var size = itemSize(item);
  var x = item.center.x - size.w/2;
  var y = item.center.y - size.h/2;
  if (!item.faceDown) {
    drawItemFaceUp(img, x, y, size);
  }
  else {
    var transparent = false;
    myPlayerAreas.forEach(function(area) {
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
  if (item.selected == true) {
    drawSelectionBorder(x, y, size);
  }
  if (item.isPlayerArea != null) {
    drawPlayerAreaBorder(item, x, y, size);
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

function drawPlayerAreaBorder(item, x, y, size) {
  context.lineWidth = 1;
  if (item.isPlayerArea == playerId) {
    context.strokeStyle = "green";
  }
  else {
    context.strokeStyle = "red";
  }
  context.strokeRect(x, y, size.w, size.h);
}

// called when new sync data is recieved
function newData(json) {
  if (json.length == 0) json = "[]";
  var newItems = JSON.parse(json);
  // TODO: check that newItems is an array of items
  items = newItems;
  items.forEach(ensureItemImage);
  sortItems();
  repaint();
}

// utility function for sorting
function comparing(feature) {
  return function(a, b) {
      return feature(b) - feature(a);
    };
}

// sort item array by size
function sortItems() {
  items.sort(comparing(itemSizeMeasure));
}

// array of only the currently selected items
function selectedItems() {
  return items.filter(function(item) {
      return item.selected;
    });
}
function notSelectedItems() {
  return items.filter(function(item) {
      return !item.selected;
    });
}

function moveItem(dx, dy) {
  return function(item) {
    item.center.x += dx;
    item.center.y += dy;
  };
}
function scaleItem(factor) {
  return function(item) {
    item.scale *= factor;
  }
}

// the foremost item covering the given point,
// or null
function itemAt(x, y) {
  // search items from front to back
  var i;
  for (i = items.length-1; i>=0; i--) {
    var item = items[i];
    if (itemCovers(item, x, y)) {
      return item;
    }
  }
  return null;
}

// does the item contain the point?
function itemCovers(item, x, y) {
  var size = itemSize(item);
  var x_rel = x - item.center.x;
  var y_rel = y - item.center.y;
  if ( x_rel < -size.w/2 || x_rel >= size.w/2 ||
       y_rel < -size.h/2 || y_rel >= size.h/2 ) {
    return false;
  }
  // I would like to check the alpha value of the items image now,
  // but this is forbidden for images from other domains...
  return true;
}

function itemIsContainedIn(inner, outer) {
  var s0 = itemSize(inner);
  var s1 = itemSize(outer);
  var dx = inner.center.x - outer.center.x;
  var dy = inner.center.y - outer.center.y;
  var dw = s1.w - s0.w;
  var dh = s1.h - s0.h;
  return ( dx > -dw/2 && dx < dw/2 && dy > -dh/2 && dy < dh/2 );
}

// selecting items

function deselectAll() {
  items.forEach(function(item) {item.selected = false;});
}

function setSelected(item, value) {
  if (item == null || item.locked) return;
  // Items in piles select and deselect together,
  // except for the topmost one.
  if (isNonTopPileMember(item)) {
    wholePile(item).forEach(function(i) {i.selected = value;});
  }
  else {
    item.selected = value;
  }
}

function toggleSelected(item) {
  setSelected(item, !item.selected);
}

function toggleLocked(item) {
  if (item == null) return;
  if (item.locked) {
    item.locked = false;
    item.isPlayerArea = null;
    setSelected(item, true);
  }
  else {
    item.locked = true;
    item.selected = false;
  }
  repaint();
  sendSyncData();
}

function cloneItem(item) {
  var clone = addItem(
      item.imgurl
    , {x: item.center.x + 20, y: item.center.y + 20}
    , item.scale );
  return clone;
}

function cloneSelected() {
  var clones = [];
  selectedItems().forEach(function(item) {
    setSelected(item, false);
    clones.push(cloneItem(item));
  });
  clones.forEach(function(item) {setSelected(item, true);});
  repaint();
  sendSyncData();
}

function deleteSelected() {
  items = notSelectedItems();
  repaint();
  sendSyncData();
}

function flipSelected() {
  var allFaceDown = true;
  selectedItems().forEach(function(item) {
    allFaceDown = allFaceDown && item.faceDown;
  });
  selectedItems().forEach(function(item) {
    item.faceDown = !allFaceDown;
  });
  repaint();
  sendSyncData();
}

function shuffleSelected() {
  // Collect the bottoms of all piles with selected items.
  var bottoms = [];
  selectedItems().forEach(function(item) {
    var b = bottomOfPile(item);
    if (!arrayIncludes(bottoms, b)) {
      bottoms.push(b);
    }
  });
  console.log("shuffling " + bottoms.length + " piles...");
  // Shuffle each pile individually.
  bottoms.forEach(function(b) {
    var bottomOfCenter = {x: b.center.x, y: b.center.y};
    var pile = wholePile(b);
    shuffleArray(pile);
    arrangeShuffledPile(pile, bottomOfCenter, roundedItemSize(b));
  });
  deselectAll();
  sortItems();
  repaint();
  sendSyncData();
}

function arrayIncludes(a, e) {
  var result = false;
  a.forEach(function(x) {
    if (x == e) {
      result = true;
    }
  });
  return result;
}

// Fischer-Yates-shuffle
function shuffleArray(a) {
  var i;
  for (i = a.length-1; i>=0; i--) {
    var j = Math.floor(Math.random() * (i+1));
    var tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
}

function claimPlayerArea() {
  var selected = selectedItems();
  if (selected.length == 1) {
    selected[0].locked = true;
    selected[0].selected = false;
    selected[0].isPlayerArea = playerId;
  }
  repaint();
  sendSyncData();
}

// piling related stuff

function roundedItemSize(item) {
  var s0 = itemSize(item);
  return {w: Math.round(s0.w), h: Math.round(s0.h)};
}

// Two items can only go on the same pile
// if they have the same rounded size.
function hasRoundedSize(roundedSize, item) {
  var s0 = roundedSize;
  var s1 = roundedItemSize(item);
  return s0.w == s1.w && s0.h == s1.h;
}

function expectedPileNeighbourPosition(item, d) {
  var size = roundedItemSize(item)
  var dx = size.w * 0.25 * d;
  var dy = 0;
  return {x: item.center.x + dx, y: item.center.y + dy};
}

function isPileNeighbour(item, d, tolerance) {
  var size = roundedItemSize(item)
  var expected = expectedPileNeighbourPosition(item, d);
  return function(other) {
    var c0 = item != other;
    var c1 = hasRoundedSize(size, other);
    var c2 = Math.abs(other.center.x - expected.x) < size.w * tolerance;
    var c3 = Math.abs(other.center.y - expected.y) < size.h * tolerance;
    var c4 = other.locked == false;
    // console.log("-- " + c0 + " " + c1 + " " + c2 + " " + c3);
    return c0 && c1 && c2 && c3 && c4;
  }
}

// Find left (d=-1) or right (d=1) neighbour in a pile.
function findPileNeighbour(item, d, tolerance=0.01) {
  var neighs = items.filter(isPileNeighbour(item, d, tolerance));
  if (neighs.length == 0) {
    return null;
  }
  else {
    return neighs[0];
  }
}

function potentiallyPutOnPile(item) {
  var found = findPileNeighbour(item, -1, 0.25);
  if (found == null) {
    return false;
  }
  // Temporarily lock the item, so it does not count for the pile.
  // (Sorry for that.)
  item.locked = true;
  var topmost = topOfPile(found);
  item.locked = false;
  item.center = expectedPileNeighbourPosition(topmost, 1);
  return true;
}

// Apply funciton f to the items in a pile,
// starting at the given item, going in direction d.
function traversePile(item, d, f) {
  var i = item;
  while (i != null) {
    f(i);
    i = findPileNeighbour(i, d);
  }
}

function endOfPile(item, d) {
  var result = null;
  traversePile(item, d, function(i) {result = i;});
  return result;
}

function topOfPile(item) {
  return endOfPile(item, 1);
}

function bottomOfPile(item) {
  return endOfPile(item, -1);
}

function wholePile(item) {
  var bottom = bottomOfPile(item);
  var pile = [];
  traversePile(bottom, 1, function(i) {pile.push(i);});
  return pile;
}

function isNonTopPileMember(item) {
  return findPileNeighbour(item, 1) != null;
}

function arrangeShuffledPile(pileItems, centerOfBottom, size) {
  var center = {x: centerOfBottom.x, y: centerOfBottom.y};
  center.y += 0.5 * size.h;
  for (var i = 0; i < pileItems.length; i++) {
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
    setTimeout(function() {ui.newItemText.focus();}, 1);
  }
}

// user clicked add new item button
function onAddNewItem() {
  var imgurl = ui.newItemText.value;
  ui.newItemText.value = "";
  toggleNewItemDiv(false);
  addItem(imgurl, {x: 0, y: 0}, 1);
  repaint();
  sendSyncData();
}

function sendSyncData() {
  if (socket != null) {
    socket.send(JSON.stringify(items));
  }
}

function tryConnect() {
  if (socket != null) {
    disconnect();
  }
  var url = domain + "/table-" + ui.tableNameText.value;
  socket = new WebSocket(url);
  socket.onclose = disconnect;
  socket.onerror = disconnect;
  socket.onopen = onConnected;
  socket.onmessage = onMessage;
}

function onMessage(e) {
  // read json string from the blob e.data
  var reader = new FileReader();
  reader.onload = function() {
    newData(reader.result);
  }
  reader.onerror = function() {
    console.log("error reading received blob");
  }
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
