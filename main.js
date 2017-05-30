"use strict";

// address for stupid-sync connection
var domain = "ws://stupidtabletop.ddns.net:39141";

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
// , pos: {x: ..., y: ...}
// , selected: <a bool>
// , locked: <a bool>
// }

// image data,
// dictionary from urls to image objects
// (each image object gets an extra "loaded" attribute when loaded)
var images = {};

// last known mouse position as {x: ..., y: ...}
// or null (if mouse is not pressed or outside the canvas)
var lastDragPos = null;

// are some items currently being dragged?
// (then send sync data on mouse up)
var dragging = false;

// the websocket
var socket = null;
// null when there is no current connection or conntection attempt


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

  setCanvasResolution();
  window.onresize = setCanvasResolution;

  // input handlers
  canvas.onmousedown = onMouseDown;
  canvas.ondblclick = onDblClick;
  canvas.onmousemove = onMouseMove;
  canvas.onmouseout = onMouseOut;
  canvas.onmouseup = onMouseUp;
  canvas.onkeydown = onKeyDown;
  // (the canvas has a tabindex for onkeydown to work)
}

function setCanvasResolution() {
  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
  repaint();
}

function repaint() {
  context.clearRect(0, 0, canvas.width, canvas.height);
  items.forEach(drawItem);
}

// input handling

function onMouseDown(e) {
  var pos = eventCoordinates(e);
  if (e.buttons==1) {
    lastDragPos = {x: pos.x, y: pos.y};
    var item = itemAt(pos.x, pos.y);
    if (item != null && item.locked == true) {
      item = null;
    }
    if (!e.shiftKey) {
      if (item == null || item.selected != true) {
        deselectAll();
        selectItem(item);
      }
    }
    else {
      toggleSelected(item);
    }
    repaint();
  }
  else {
    finishDragging();
  }
}
function onDblClick(e) {
  var pos = eventCoordinates(e);
  var item = itemAt(pos.x, pos.y);
  toggleLocked(item);
}
function onMouseMove(e) {
  var pos = eventCoordinates(e);
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
  if (e.buttons==1) {
    dragging = true;
  }
  else {
    finishDrag();
  }
}

function onKeyDown(e) {
  if (e.key=="Escape") {
    console.log("escape");
  }
  if (e.key=="c") {
    cloneSelected();
  }
  if (e.key=="Delete" || e.key=="Backspace") {
    deleteSelected();
  }
  if (e.key=="a") {
    toggleNewItemDiv();
  }
}

// convert client coordinates of an event to
// canvas-relative coordinates (as for drawing)
function eventCoordinates(e) {
  var pos =
    { x: e.pageX - canvas.offsetLeft
    , y: e.pageY - canvas.offsetTop };
  return pos;
}

function finishDrag() {
  if (dragging != true) {
    return;
  }
  console.log("finishing drag");
  dragging = false;
  sendSyncData();
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
function enshureItemImage(item) {
  if (images[item.imgurl] == null) {
    addImage(item.imgurl);
  }
}

// add item to items array (and also return it)
function addItem(imgurl, pos) {
  var item =
    { imgurl: imgurl
    , pos: {x: pos.x, y: pos.y}
    , selected: false
    , locked: false };
  items.push(item);
  enshureItemImage(item);
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
  if (img != null) {
    return {w: img.width, h: img.height};
  }
  else {
    // default size
    return {w: 50, h: 50}
  }
}

// a number representing the size of the item
// (for sorting by size)
function itemSizeMeasure(item) {
  var size = itemSize(item);
  return size.w * size.h;
}

function drawItem(item) {
  var img = itemImage(item);
  var size = itemSize(item);
  if (img != null) {
    context.drawImage(img, item.pos.x, item.pos.y);
  }
  else {
    context.fillStyle="grey";
    context.fillRect(item.pos.x, item.pos.y, size.w, size.h);
  }
  if (item.selected == true) {
    context.strokeStyle="black";
    context.strokeRect(item.pos.x-0.5, item.pos.y-0.5, size.w+1, size.h+1);
    context.strokeStyle="yellow";
    context.strokeRect(item.pos.x-1.5, item.pos.y-1.5, size.w+3, size.h+3);
  }
}

// called when new sync data is recieved
function newData(json) {
  if (json.length == 0) json = "[]";
  var newItems = JSON.parse(json);
  // TODO: check that newItems is an array of items
  items = newItems;
  items.forEach(enshureItemImage);
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
    item.pos.x += dx;
    item.pos.y += dy;
  };
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
  var x_rel = x - item.pos.x;
  var y_rel = y - item.pos.y;
  if ( x_rel < 0 || x_rel >= size.w ||
       y_rel < 0 || y_rel >= size.h ) {
    return false;
  }
  // I would like to check the alpha value of the items image now,
  // but this is forbidden for images from other domains...
  return true;
}

// selecting items

function deselectAll() {
  items.forEach(function(item) {item.selected = false;});
}

function selectItem(item) {
  if (item == null) return;
  if (!item.locked) {
    item.selected = true;
  }
}

function toggleSelected(item) {
  if (item == null) return;
  if (!item.locked) {
    item.selected = !item.selected;
  }
}

function toggleLocked(item) {
  if (item == null) return;
  item.locked = !item.locked;
  item.selected = !item.locked;
  repaint();
  sendSyncData();
}

function cloneItem(item) {
  var clone = addItem(item.imgurl, {x: item.pos.x, y: item.pos.y});
  moveItem(10, 10)(clone);
  selectItem(clone);
  item.selected = false;
}

function cloneSelected() {
  selectedItems().forEach(cloneItem);
  selectedItems().forEach(moveItem(10, 10));
  repaint();
  sendSyncData();
}

function deleteSelected() {
  items = notSelectedItems();
  repaint();
  sendSyncData();
}

// hide or show new item line
function toggleNewItemDiv(on) {
  if (on==null) {
    on = ui.newItemDiv.style.display == "none";
  }
  ui.newItemDiv.style.display = (on ? "flex" : "none");
}

// user clicked add new item button
function onAddNewItem() {
  var imgurl = ui.newItemText.value;
  ui.newItemText.value = "";
  toggleNewItemDiv(false);
  addItem(imgurl, {x: 50, y: 50});
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
  var url = domain + "/stupid-tabletop/" + ui.tableNameText.value;
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
