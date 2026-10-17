using System;
using System.Collections.Generic;
using System.Text;

namespace ValheimResourceManager
{
    // Pure helpers shared by the runtime exporter and the game-independent contract tests.
    public static class RegistryAlgorithms
    {
        public struct Point { public float X, Y; public Point(float x, float y) { X = x; Y = y; } }

        // RFC-4180 style quoted cells, including multiline cells and doubled quote escapes.
        // Every source record is yielded (blank records included), allowing a bounded runtime reader.
        public static IEnumerable<List<string>> CsvRows(string text)
        {
            var row = new List<string>(); var cell = new StringBuilder(); bool quoted = false;
            for (int i = 0; i < text.Length; i++)
            {
                char c = text[i];
                if (c == '"')
                {
                    if (quoted && i + 1 < text.Length && text[i + 1] == '"') { cell.Append('"'); i++; }
                    else quoted = !quoted;
                }
                else if (!quoted && (c == ',' || c == '\n'))
                {
                    row.Add(cell.ToString().TrimEnd('\r')); cell.Length = 0;
                    if (c == '\n') { yield return row; row = new List<string>(); }
                }
                else cell.Append(c);
            }
            if (cell.Length != 0 || row.Count != 0) { row.Add(cell.ToString().TrimEnd('\r')); yield return row; }
        }

        // Sprite mesh vertices define the ORIGINAL untrimmed pixel canvas; UVs define the
        // actual atlas crop. Using the real triangles handles tight packing and all rotations
        // without guessing a packing orientation or stretching a trimmed texture rectangle.
        public static uint[] Rasterize(int width, int height, Point[] vertices, Point[] sourcePixels,
            ushort[] triangles, uint[] crop, int cropWidth, int cropHeight, int cropX, int cropY)
        {
            if (width <= 0 || height <= 0 || vertices.Length != sourcePixels.Length || triangles.Length % 3 != 0 || crop.Length != cropWidth * cropHeight)
                throw new ArgumentException("Invalid sprite mesh or atlas crop");
            var result = new uint[width * height];
            for (int t = 0; t < triangles.Length; t += 3)
            {
                int ia = triangles[t], ib = triangles[t + 1], ic = triangles[t + 2];
                var a = vertices[ia]; var b = vertices[ib]; var c = vertices[ic];
                float denominator = (b.Y - c.Y) * (a.X - c.X) + (c.X - b.X) * (a.Y - c.Y);
                if (Math.Abs(denominator) < 0.000001f) continue;
                int minX = Math.Max(0, (int)Math.Floor(Math.Min(a.X, Math.Min(b.X, c.X))));
                int maxX = Math.Min(width - 1, (int)Math.Ceiling(Math.Max(a.X, Math.Max(b.X, c.X))));
                int minY = Math.Max(0, (int)Math.Floor(Math.Min(a.Y, Math.Min(b.Y, c.Y))));
                int maxY = Math.Min(height - 1, (int)Math.Ceiling(Math.Max(a.Y, Math.Max(b.Y, c.Y))));
                for (int y = minY; y <= maxY; y++) for (int x = minX; x <= maxX; x++)
                {
                    float px = x + 0.5f, py = y + 0.5f;
                    float wa = ((b.Y - c.Y) * (px - c.X) + (c.X - b.X) * (py - c.Y)) / denominator;
                    float wb = ((c.Y - a.Y) * (px - c.X) + (a.X - c.X) * (py - c.Y)) / denominator;
                    float wc = 1f - wa - wb;
                    if (wa < -0.00001f || wb < -0.00001f || wc < -0.00001f) continue;
                    int sx = (int)Math.Floor(sourcePixels[ia].X * wa + sourcePixels[ib].X * wb + sourcePixels[ic].X * wc) - cropX;
                    int sy = (int)Math.Floor(sourcePixels[ia].Y * wa + sourcePixels[ib].Y * wb + sourcePixels[ic].Y * wc) - cropY;
                    if (sx >= 0 && sy >= 0 && sx < cropWidth && sy < cropHeight) result[y * width + x] = crop[sy * cropWidth + sx];
                }
            }
            return result;
        }
    }
}
