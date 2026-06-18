import zlib
import struct
import math
import os

def write_png(buf, width, height, filepath):
    # PNG signature
    png = bytearray([137, 80, 78, 71, 13, 10, 26, 10])
    
    # IHDR chunk
    ihdr_data = struct.pack("!IIBBBBB", width, height, 8, 6, 0, 0, 0)
    def chunk(tag, data):
        return struct.pack("!I", len(data)) + tag + data + struct.pack("!I", zlib.crc32(tag + data))
    
    png += chunk(b"IHDR", ihdr_data)
    
    # IDAT chunk
    raw_data = bytearray()
    for y in range(height):
        raw_data.append(0) # Filter type 0 (None)
        for x in range(width):
            r, g, b, a = buf[y * width + x]
            raw_data.extend([r, g, b, a])
            
    png += chunk(b"IDAT", zlib.compress(raw_data))
    png += chunk(b"IEND", b"")
    
    # Write to file
    with open(filepath, "wb") as f:
        f.write(png)

def generate_icon(size, filepath):
    cx, cy = size / 2.0, size / 2.0
    r_badge = size * 0.46
    
    # Vertices of play button triangle
    # Facing right
    x1, y1 = cx + size * 0.14, cy
    x2, y2 = cx - size * 0.10, cy - size * 0.14
    x3, y3 = cx - size * 0.10, cy + size * 0.14
    
    # Helper to check if a point is inside the triangle
    def inside_triangle(px, py):
        d1 = (px - x2) * (y1 - y2) - (py - y2) * (x1 - x2)
        d2 = (px - x3) * (y2 - y3) - (py - y3) * (x2 - x3)
        d3 = (px - x1) * (y3 - y1) - (py - y1) * (x3 - x1)
        has_neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
        has_pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
        return not (has_neg and has_pos)

    pixels = []
    
    # For antialiasing, we do 3x3 supersampling
    subsamples = [-0.33, 0.0, 0.33]
    
    for y in range(size):
        for x in range(size):
            r_acc, g_acc, b_acc, a_acc = 0, 0, 0, 0
            
            for sy in subsamples:
                for sx in subsamples:
                    px = x + 0.5 + sx
                    py = y + 0.5 + sy
                    
                    dx = px - cx
                    dy = py - cy
                    dist = math.sqrt(dx*dx + dy*dy)
                    
                    # Background circle badge
                    if dist <= r_badge:
                        # Linear gradient from top-left (indigo) to bottom-right (violet)
                        # Indigo: rgb(99, 102, 241), Violet: rgb(168, 85, 247)
                        # We use projection onto the diagonal
                        t = (dx + dy) / (2.0 * r_badge) + 0.5
                        t = max(0.0, min(1.0, t))
                        bg_r = int(99 + (168 - 99) * t)
                        bg_g = int(102 + (85 - 102) * t)
                        bg_b = int(241 + (247 - 241) * t)
                        bg_a = 255
                        
                        # Clock history ring (arc)
                        # Radius between 0.28 and 0.36
                        ring_inner = size * 0.26
                        ring_outer = size * 0.34
                        angle = math.atan2(dy, dx) # -pi to pi
                        
                        is_ring = False
                        if ring_inner <= dist <= ring_outer:
                            # We draw a partial ring: 3/4 circle (from -pi/2 to pi)
                            if angle >= -math.pi/2 or angle <= -math.pi:
                                is_ring = True
                        
                        if is_ring:
                            # Draw ring in semi-transparent white
                            # Blend with background
                            bg_r = int(bg_r * 0.3 + 255 * 0.7)
                            bg_g = int(bg_g * 0.3 + 255 * 0.7)
                            bg_b = int(bg_b * 0.3 + 255 * 0.7)
                        
                        # Play button triangle inside
                        if inside_triangle(px, py):
                            # Draw play button in solid white
                            bg_r, bg_g, bg_b, bg_a = 255, 255, 255, 255
                            
                        r_acc += bg_r
                        g_acc += bg_g
                        b_acc += bg_b
                        a_acc += bg_a
                    else:
                        # Transparent background
                        r_acc += 0
                        g_acc += 0
                        b_acc += 0
                        a_acc += 0
                        
            # Average the supersamples
            r_avg = int(r_acc / 9.0)
            g_avg = int(g_acc / 9.0)
            b_avg = int(b_acc / 9.0)
            a_avg = int(a_acc / 9.0)
            
            pixels.append((r_avg, g_avg, b_avg, a_avg))
            
    write_png(pixels, size, size, filepath)
    print(f"Generated {filepath} ({size}x{size})")

if __name__ == "__main__":
    os.makedirs("icons", exist_ok=True)
    generate_icon(16, "icons/icon-16.png")
    generate_icon(48, "icons/icon-48.png")
    generate_icon(128, "icons/icon-128.png")
