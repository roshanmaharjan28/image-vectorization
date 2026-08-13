def segments_to_path_d(loops: list) -> str:
    """loops: list of loops, each a list of 4x2 bezier segments [P0,P1,P2,P3]
    with consecutive segments sharing endpoints. Emits one 'M ... C ... Z'
    subpath per loop (outer boundary first, then any holes), concatenated into
    a single 'd' string."""
    parts = []
    for loop in loops:
        if not loop:
            continue
        start = loop[0][0]
        parts.append(f"M {start[0]:.2f},{start[1]:.2f}")
        for seg in loop:
            _, c1, c2, end = seg
            parts.append(f"C {c1[0]:.2f},{c1[1]:.2f} {c2[0]:.2f},{c2[1]:.2f} {end[0]:.2f},{end[1]:.2f}")
        parts.append("Z")
    return " ".join(parts)


def build_region_path(d: str, color_bgr: tuple) -> str:
    b, g, r = color_bgr
    hex_color = f"#{r:02x}{g:02x}{b:02x}"
    # evenodd handles arbitrarily nested outer/hole loops correctly regardless
    # of OpenCV's contour winding direction - no winding-order fixup needed.
    return f'<path d="{d}" fill="{hex_color}" fill-rule="evenodd" />'


def build_svg_document(width: int, height: int, path_elements: list) -> str:
    paths = "".join(path_elements)
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}">{paths}</svg>'
    )
