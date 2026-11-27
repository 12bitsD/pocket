"""Pure-Python ISO/IEC 18004 QR encoder (Versions 1-6, ECC Level L)."""

from __future__ import annotations

# (version, size, total_data_bytes, ec_per_block, blocks, align_center)
QR_SPECS = (
    (1, 21, 19, 7, 1, 0),
    (2, 25, 34, 10, 1, 18),
    (3, 29, 55, 15, 1, 22),
    (4, 33, 80, 20, 1, 26),
    (5, 37, 108, 26, 1, 30),
    (6, 41, 136, 18, 2, 34),
)
FORMAT_L_MASK0 = 0x77C4


def gf_mul(left: int, right: int) -> int:
    x, y, res = left, right, 0
    for _ in range(8):
        if y & 1:
            res ^= x
        hi = x & 0x80
        x = (x << 1) & 0xFF
        if hi:
            x ^= 0x1D
        y >>= 1
    return res


def rs_generator(degree: int) -> list[int]:
    poly = [1]
    root = 1
    for _ in range(degree):
        nxt = [0] * (len(poly) + 1)
        for idx, coeff in enumerate(poly):
            nxt[idx] ^= coeff
            nxt[idx + 1] ^= gf_mul(coeff, root)
        poly = nxt
        root = gf_mul(root, 2)
    return poly


def rs_remainder(data: list[int], ec_len: int) -> list[int]:
    gen = rs_generator(ec_len)
    rem = [0] * ec_len
    for byte in data:
        factor = byte ^ rem[0]
        rem = rem[1:] + [0]
        for idx in range(ec_len):
            rem[idx] ^= gf_mul(gen[idx + 1], factor)
    return rem


def select_spec(byte_len: int) -> tuple[int, int, int, int, int, int]:
    for spec in QR_SPECS:
        if byte_len + 2 <= spec[2]:
            return spec
    raise ValueError("QR payload exceeds 134 bytes")


def encode_data_codewords(payload: bytes, data_cap: int) -> list[int]:
    bits = [0, 1, 0, 0]
    for shift in range(7, -1, -1):
        bits.append((len(payload) >> shift) & 1)
    for byte in payload:
        for shift in range(7, -1, -1):
            bits.append((byte >> shift) & 1)
    bits.extend([0] * min(4, data_cap * 8 - len(bits)))
    while len(bits) % 8 != 0:
        bits.append(0)
    words = [
        sum(bits[i + j] << (7 - j) for j in range(8))
        for i in range(0, len(bits), 8)
    ]
    pads = (0xEC, 0x11)
    while len(words) < data_cap:
        words.append(pads[len(words) % 2])
    return words


def build_codewords(payload: bytes, spec: tuple) -> list[int]:
    _, _, data_cap, ec_len, blocks, _ = spec
    words = encode_data_codewords(payload, data_cap)
    chunk = data_cap // blocks
    data_blocks = [words[i * chunk : (i + 1) * chunk] for i in range(blocks)]
    ec_blocks = [rs_remainder(blk, ec_len) for blk in data_blocks]
    out = [blk[i] for i in range(chunk) for blk in data_blocks]
    out.extend(blk[i] for i in range(ec_len) for blk in ec_blocks)
    return out


def set_fn(canvas: tuple, pos: tuple[int, int], val: int) -> None:
    grid, fn_map = canvas
    grid[pos[0]][pos[1]] = val
    fn_map[pos[0]][pos[1]] = True


def draw_finder(canvas: tuple, top: int, left: int) -> None:
    size = len(canvas[0])
    for dr in range(-1, 8):
        for dc in range(-1, 8):
            r, c = top + dr, left + dc
            if 0 <= r < size and 0 <= c < size:
                ring = max(abs(dr - 3), abs(dc - 3))
                dark = int(ring in (0, 1, 3) and 0 <= dr <= 6 and 0 <= dc <= 6)
                set_fn(canvas, (r, c), dark)


def draw_alignment(canvas: tuple, center: int) -> None:
    if center <= 0:
        return
    for dr in range(-2, 3):
        for dc in range(-2, 3):
            dark = int(max(abs(dr), abs(dc)) != 1)
            set_fn(canvas, (center + dr, center + dc), dark)


def draw_function_patterns(canvas: tuple, align: int) -> None:
    size = len(canvas[0])
    for top, left in ((0, 0), (0, size - 7), (size - 7, 0)):
        draw_finder(canvas, top, left)
    draw_alignment(canvas, align)
    for idx in range(8, size - 8):
        dark = int(idx % 2 == 0)
        set_fn(canvas, (6, idx), dark)
        set_fn(canvas, (idx, 6), dark)
    set_fn(canvas, (size - 8, 8), 1)


def reserve_and_write_format(canvas: tuple) -> None:
    size = len(canvas[0])
    for i in range(15):
        bit = (FORMAT_L_MASK0 >> i) & 1
        r1 = i if i < 6 else (i + 1 if i < 8 else size - 15 + i)
        c2 = size - 1 - i if i < 8 else (14 - i if i > 8 else 7)
        set_fn(canvas, (r1, 8), bit)
        set_fn(canvas, (8, c2), bit)


def iter_strip_coords(col: int, row_order: range, fn_map: list):
    for row in row_order:
        for dc in (0, -1):
            if not fn_map[row][col + dc]:
                yield row, col + dc


def iter_data_coords(size: int, fn_map: list):
    col = size - 1
    upward = True
    while col > 0:
        if col == 6:
            col -= 1
        order = range(size - 1, -1, -1) if upward else range(size)
        yield from iter_strip_coords(col, order, fn_map)
        upward = not upward
        col -= 2


def fill_data_bits(
    grid: list, fn_map: list, words: list[int]
) -> None:
    bits = [(w >> s) & 1 for w in words for s in range(7, -1, -1)]
    for idx, (row, col) in enumerate(iter_data_coords(len(grid), fn_map)):
        raw = bits[idx] if idx < len(bits) else 0
        grid[row][col] = raw ^ int((row + col) % 2 == 0)


def encode_qr_matrix(text: str) -> list[list[int]]:
    payload = text.encode("utf-8")
    spec = select_spec(len(payload))
    size = spec[1]
    grid = [[0] * size for _ in range(size)]
    fn_map = [[False] * size for _ in range(size)]
    draw_function_patterns((grid, fn_map), spec[5])
    reserve_and_write_format((grid, fn_map))
    fill_data_bits(grid, fn_map, build_codewords(payload, spec))
    return grid


def qr_to_svg(text: str) -> str:
    matrix = encode_qr_matrix(text)
    full = len(matrix) + 4
    paths = [
        f"M{c + 2},{r + 2}h1v1h-1z"
        for r, row in enumerate(matrix)
        for c, val in enumerate(row)
        if val
    ]
    d_attr = "".join(paths)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {full} {full}" '
        f'shape-rendering="crispEdges" role="img" aria-label="配对二维码">'
        f'<rect width="{full}" height="{full}" fill="#fffefb"/>'
        f'<path fill="#1a1917" d="{d_attr}"/></svg>'
    )


def qr_to_terminal(text: str) -> str:
    matrix = encode_qr_matrix(text)
    blank = [0] * (len(matrix) + 2)
    padded = [blank] + [[0] + row + [0] for row in matrix] + [blank]
    if len(padded) % 2 == 1:
        padded.append(blank)
    glyphs = {(0, 0): " ", (1, 0): "▀", (0, 1): "▄", (1, 1): "█"}
    lines = [
        "".join(glyphs[(t, b)] for t, b in zip(padded[r], padded[r + 1]))
        for r in range(0, len(padded), 2)
    ]
    return "\n".join(lines)
