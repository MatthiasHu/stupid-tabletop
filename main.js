"use strict";

var canvas;
var context;

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


function onLoad() {
  canvas = document.getElementById("bigcanvas");
  context = canvas.getContext("2d");

  // input handlers
  canvas.onmousedown = onMouseDown;
  canvas.onmousemove = onMouseMove;
  canvas.onmouseout = onMouseOut;
  canvas.onmouseup = onMouseUp;
  window.onkeydown = onKeyDown;

  // test sync data
  newData(JSON.stringify(
    [ {imgurl: "images/test.png", pos: {x: 10, y: 20}, selected: false, locked: false}
    , {imgurl: "https://upload.wikimedia.org/wikipedia/commons/b/bc/Face-grin.svg", pos: {x: 200, y: 100}, selected: false, locked:false}
    , {imgurl: "images/face.svg", pos: {x: 100, y: 100}, selected: true, locked:false}
    ] ));
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
}

// convert client coordinates of an event to
// canvas-relative coordinates (as for drawing)
function eventCoordinates(e) {
  var pos =
    { x: e.clientX - canvas.offsetLeft
    , y: e.clientY - canvas.offsetTop };
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
    context.strokeStyle="yellow";
    context.strokeRect(item.pos.x, item.pos.y, size.w, size.h);
  }
}

// called when new sync data is recieved
function newData(json) {
  var newItems = JSON.parse(json);
  // TODO: check that newItems is an array of items
  console.log("newItems: " + newItems);
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

function sendSyncData() {
  // TODO: this
}
