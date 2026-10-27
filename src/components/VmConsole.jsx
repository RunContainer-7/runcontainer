import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  connectVmConsole,
  disconnectVmConsole,
  onVmConsoleData,
  onVmConsoleStatus,
  writeVmConsole,
} from "../services/containerService";
import { RfbSession, keyToKeysym } from "../services/rfbClient";

// The guest's screen, drawn inside this window.
//
// QEMU serves the VM over RFB on loopback; the main process holds that socket and sends
// the bytes here, and everything this component sends back goes the same way. The guest
// paints into a canvas, so there is no second window on the desktop and the console
// lives inside the RunContainer tab that started it.
//
// Experimental: raw frames over loopback are fast enough to use and slow enough to
// notice, and a guest that repaints constantly will feel it.
const SHIFT_KEYSYM = 0xffe1;
const CTRL_KEYSYM = 0xffe3;
const ALT_KEYSYM = 0xffe9;

export default function VmConsole({ vm }) {
  const canvasRef = useRef(null);
  const sessionRef = useRef(null);
  const sizeRef = useRef({ width: 640, height: 480 });
  const [status, setStatus] = useState("Connecting to the console…");
  const [error, setError] = useState(null);
  const [size, setSize] = useState(null);

  const send = useCallback((bytes) => {
    if (!bytes || !vm?.id) return;
    Promise.resolve(writeVmConsole(vm.id, bytes)).catch(() => {});
  }, [vm?.id]);

  const resizeCanvas = useCallback((width, height) => {
    const canvas = canvasRef.current;
    sizeRef.current = { width, height };
    setSize({ width, height });
    if (!canvas) return;
    // Setting the attributes clears the canvas, which is correct here: the guest is
    // about to repaint at the new size, and a stale image at the wrong size is worse.
    canvas.width = width;
    canvas.height = height;
  }, []);

  const paint = useCallback((rect) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    if (rect.encoding === "copy") {
      // A scroll: the guest tells us to copy a region of what is already shown.
      context.drawImage(
        canvas,
        rect.sourceX, rect.sourceY, rect.width, rect.height,
        rect.x, rect.y, rect.width, rect.height,
      );
      return;
    }
    context.putImageData(new ImageData(rect.rgba, rect.width, rect.height), rect.x, rect.y);
  }, []);

  useEffect(() => {
    if (!vm?.id) return undefined;
    const session = new RfbSession({
      onReady: ({ width, height }) => {
        resizeCanvas(width, height);
        setStatus("Connected. Click the screen to send it your keyboard.");
        setError(null);
      },
      onResize: (width, height) => resizeCanvas(width, height),
      onRect: paint,
      onError: (message) => {
        setError(message);
        setStatus("The console stopped drawing.");
      },
    });
    sessionRef.current = session;
    const flush = () => {
      for (const message of session.takeOutbox()) send(message);
    };

    const offData = onVmConsoleData((payload) => {
      if (!payload || payload.id !== vm.id) return;
      session.receive(payload.bytes);
      flush();
    });
    const offStatus = onVmConsoleStatus((payload) => {
      if (!payload || payload.id !== vm.id) return;
      if (payload.state === "connected") setStatus("Negotiating with the guest console…");
      if (payload.state === "error") setError(payload.error || "The console connection failed.");
      if (payload.state === "closed") setStatus("The console disconnected.");
    });

    Promise.resolve(connectVmConsole(vm))
      .then((result) => {
        if (!result?.connected) {
          setError(result?.error || "The console could not be opened.");
          setStatus("No console connection.");
        }
      })
      .catch((failure) => {
        setError(failure?.message || String(failure));
        setStatus("No console connection.");
      });

    return () => {
      offData();
      offStatus();
      sessionRef.current = null;
      Promise.resolve(disconnectVmConsole(vm.id)).catch(() => {});
    };
  }, [vm?.id, paint, resizeCanvas, send]);

  const guestPoint = (event) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const bounds = canvas.getBoundingClientRect();
    const { width, height } = sizeRef.current;
    if (!bounds.width || !bounds.height) return { x: 0, y: 0 };
    return {
      x: (event.clientX - bounds.left) * (width / bounds.width),
      y: (event.clientY - bounds.top) * (height / bounds.height),
    };
  };

  const sendPointer = (event, mask) => {
    const session = sessionRef.current;
    if (!session) return;
    const { x, y } = guestPoint(event);
    send(session.pointer(x, y, mask));
  };

  const sendKey = (keysym, down) => {
    const session = sessionRef.current;
    if (!session) return;
    send(session.key(keysym, down));
  };

  const handleKeyDown = (event) => {
    if (event.repeat) {
      event.preventDefault();
      return;
    }
    const mapped = keyToKeysym({ key: event.key });
    if (!mapped) return;
    event.preventDefault();
    // A capital letter or a shifted symbol is Shift plus the unshifted key, which is
    // what a guest with an unusual layout expects to receive.
    if (mapped.needsShift) sendKey(SHIFT_KEYSYM, true);
    sendKey(mapped.keysym, true);
    if (mapped.needsShift) sendKey(SHIFT_KEYSYM, false);
  };

  const handleKeyUp = (event) => {
    const mapped = keyToKeysym({ key: event.key });
    if (!mapped) return;
    event.preventDefault();
    sendKey(mapped.keysym, false);
  };

  const sendThreeFingerSalute = () => {
    const session = sessionRef.current;
    if (!session) return;
    sendKey(CTRL_KEYSYM, true);
    sendKey(ALT_KEYSYM, true);
    sendKey(0xffff, true); // Delete
    sendKey(0xffff, false);
    sendKey(ALT_KEYSYM, false);
    sendKey(CTRL_KEYSYM, false);
  };

  return (
    <div className="vm-console">
      <div className="vm-console-head">
        <span className="vm-console-status" role="status">
          {status}
          {size ? ` Guest screen: ${size.width}×${size.height}.` : ""}
        </span>
        <div className="vm-console-actions">
          <button type="button" className="settings-button ghost" onClick={sendThreeFingerSalute}>Send Ctrl+Alt+Del</button>
        </div>
      </div>
      {error && <p className="status-line" role="alert">{error}</p>}
      <canvas
        ref={canvasRef}
        className="vm-canvas"
        tabIndex={0}
        aria-label={`${vm?.name || "Virtual machine"} screen`}
        onMouseDown={(event) => sendPointer(event, [1, 2, 4][event.button] || 1)}
        onMouseUp={(event) => sendPointer(event, 0)}
        onMouseMove={(event) => sendPointer(event, (event.buttons & 1 ? 1 : 0) | (event.buttons & 2 ? 2 : 0) | (event.buttons & 4 ? 4 : 0))}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
      />
      <p className="muted vm-console-note">
        Click the screen and type; the keyboard goes to the guest. Raw frames are sent over
        loopback, so a busy desktop can look delayed — this console is experimental.
      </p>
    </div>
  );
}
