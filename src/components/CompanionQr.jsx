import qrcode from "qrcode-generator";

// A QR code for the companion's address. The camera app on the iPhone opens a link
// straight from this, so nobody has to read an IP address and a port off the screen
// and type it on a phone keyboard.
export default function CompanionQr({ value, size = 168, label }) {
  if (!value) return null;

  let qr = null;
  try {
    // Type 0 lets the library pick the smallest version that fits the address.
    qr = qrcode(0, "M");
    qr.addData(value);
    qr.make();
  } catch (error) {
    // An address this long would be a bug elsewhere; the copy button still works.
    return null;
  }

  const count = qr.getModuleCount();
  const quiet = 4;
  const total = count + quiet * 2;
  // Whole pixels per module: a fractional scale softens the edges and makes the code
  // harder for a camera to read.
  const rendered = Math.max(total * 3, Math.round(size / total) * total);
  const modules = [];
  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) {
      if (!qr.isDark(row, column)) continue;
      modules.push(<rect key={`${row}-${column}`} x={column + quiet} y={row + quiet} width="1" height="1" />);
    }
  }

  return (
    <svg
      className="companion-qr"
      viewBox={`0 0 ${total} ${total}`}
      width={rendered}
      height={rendered}
      role="img"
      aria-label={label || `QR code for ${value}`}
      shapeRendering="crispEdges"
    >
      <rect width={total} height={total} fill="#ffffff" />
      <g fill="#0b0f14">{modules}</g>
    </svg>
  );
}
