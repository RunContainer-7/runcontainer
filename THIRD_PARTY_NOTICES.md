# Third-party notices

## QEMU (detected dependency, NOT bundled)

RunContainer's genuine-VM backend drives an installed QEMU
(`qemu-system-x86_64`, `qemu-img`) and does not ship QEMU binaries, so no
QEMU distribution obligations are triggered by this repository.

- QEMU is released under the **GNU General Public License v2**
  (https://www.qemu.org/docs/master/about/license.html), with some parts under
  their own licenses — see the `LICENSE` file of the exact build installed.
- If a future release bundles QEMU binaries, that release must include the
  GPLv2 text, preserve QEMU copyright/warranty notices, and provide the
  complete corresponding source (or a valid written offer) for the exact
  distributed build, plus audited notices for bundled libraries, firmware, and
  any virtio-win media. Get legal review before bundling.
- Windows guest operating systems, virtio drivers, and licences always come
  from media the user owns. Nothing in this project downloads, bundles, or
  redistributes a guest OS image.

## Why this file exists

Keep this file accurate: any change from "detect" to "bundle" for QEMU (or
redistribution of driver/guest media) must update these notices first.
