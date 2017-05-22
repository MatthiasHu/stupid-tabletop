"use strict";

var canvas;
var context;
var img;
var position = {x: 0, y: 0};
var dragging = null;
  // null or {origin: {x: ..., y: ...}, current: {x: ..., y: ...}}

function onLoad() {
  console.log("workssxxxx");
  
  canvas = document.getElementById("datcanvas");
  context = canvas.getContext("2d");
  img = new Image();
  img.src = "images/test.png";
  img.onload = function() {
    console.log("loaded");
    updateImage();
  };

  canvas.onmousedown = onMouseDown;
  canvas.onmousemove = onMouseMove;
  canvas.onmouseout = onMouseOut;
  canvas.onmouseup = onMouseUp;
  window.onkeydown = onKeyDown;
}

function updateImage() {
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.globalAlpha = 1.0;
  context.drawImage(img, position.x, position.y);
  if (dragging != null) {
    context.globalAlpha = 0.5;
    var dx = dragging.current.x - dragging.origin.x;
    var dy = dragging.current.y - dragging.origin.y;
    context.drawImage(img, position.x + dx, position.y + dy);
  }
}

function onMouseDown(e) {
}
function onMouseMove(e) {
  if (e.buttons==1) {
    var mousePos = {x: e.clientX, y: e.clientY};
    if (dragging == null) {
      console.log("starting drag");
      dragging = {origin: mousePos, current: mousePos};
    }
    else {
      dragging.current = mousePos;
    }
    updateImage();
  }
}
function onMouseOut(e) {
  if (dragging) {
    abortDragging();
  }
}
function onMouseUp(e) {
  if (dragging != null) {
    finishDragging();
  }
}

function onKeyDown(e) {
  if (e.key=="Escape") {
    console.log("escape");
    if (dragging != null) {
      abortDragging();
    }
  }
}

function abortDragging() {
  dragging = null;
  updateImage();
}

function finishDragging() {
  console.log("finishing drag");
  position.x += dragging.current.x - dragging.origin.x;
  position.y += dragging.current.y - dragging.origin.y;
  dragging = null;
  updateImage();
}
