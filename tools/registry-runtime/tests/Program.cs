using ValheimResourceManager;
using Point = ValheimResourceManager.RegistryAlgorithms.Point;

int passed = 0;
void Check(bool value, string label) { if (!value) throw new Exception("FAIL: " + label); passed++; Console.WriteLine("PASS: " + label); }
void Pixels(uint[] actual, uint[] expected, string label) => Check(actual.SequenceEqual(expected), label);
var rows = RegistryAlgorithms.CsvRows("key,English,Russian\r\nwood,Wood,Древесина\r\n").ToList();
Check(rows.Count == 2 && rows[0][2] == "Russian" && rows[1][2] == "Древесина", "CSV Russian Unicode and CRLF header");
rows = RegistryAlgorithms.CsvRows("a,\"with, comma\",\"two\nlines\"\n").ToList();
Check(rows.Count == 1 && rows[0][1] == "with, comma" && rows[0][2] == "two\nlines", "CSV quoted comma and multiline cell");
rows = RegistryAlgorithms.CsvRows("a,\"say \"\"hello\"\"\",").ToList();
Check(rows[0][1] == "say \"hello\"" && rows[0][2] == "", "CSV doubled quote and final empty cell");
Check(RegistryAlgorithms.CsvRows("").Count() == 0, "CSV empty input");
Check(RegistryAlgorithms.CsvRows("\n\n").Count() == 2, "CSV blank rows keep a finite yield budget");

var vertices = new[] { new Point(0, 0), new Point(2, 0), new Point(0, 2), new Point(2, 2) };
ushort[] triangles = [0, 1, 2, 2, 1, 3];
uint[] rgba = [0xff0000ff, 0xff00ff00, 0xffff0000, 0x42010203];
var result = RegistryAlgorithms.Rasterize(2, 2, vertices, vertices, triangles, rgba, 2, 2, 0, 0);
Pixels(result, rgba, "Original RGBA composition and partial alpha remain exact");
var flipped = new[] { new Point(2, 0), new Point(0, 0), new Point(2, 2), new Point(0, 2) };
result = RegistryAlgorithms.Rasterize(2, 2, vertices, flipped, triangles, rgba, 2, 2, 0, 0);
Pixels(result, [rgba[1], rgba[0], rgba[3], rgba[2]], "Packed atlas horizontal flip uses UV mapping");
var rotated = new[] { new Point(0, 2), new Point(0, 0), new Point(2, 2), new Point(2, 0) };
result = RegistryAlgorithms.Rasterize(2, 2, vertices, rotated, triangles, rgba, 2, 2, 0, 0);
Pixels(result, [rgba[2], rgba[0], rgba[3], rgba[1]], "Packed atlas 90 degree rotation uses UV mapping");
var trimmedVertices = vertices.Select(v => new Point(v.X + 1, v.Y + 1)).ToArray();
result = RegistryAlgorithms.Rasterize(4, 4, trimmedVertices, vertices, triangles, rgba, 2, 2, 0, 0);
Pixels(result, [0, 0, 0, 0, 0, rgba[0], rgba[1], 0, 0, rgba[2], rgba[3], 0, 0, 0, 0, 0], "Trimmed sprite keeps original canvas and transparent margins");
var atlasUV = vertices.Select(v => new Point(v.X + 100, v.Y + 200)).ToArray();
result = RegistryAlgorithms.Rasterize(2, 2, vertices, atlasUV, triangles, rgba, 2, 2, 100, 200);
Pixels(result, rgba, "Atlas crop offset maps to original pixels");
result = RegistryAlgorithms.Rasterize(2, 2, vertices, vertices, [0, 1, 2], rgba, 2, 2, 0, 0);
Check(result[3] == 0 && result[0] == rgba[0], "Tight sprite triangle leaves outside pixels transparent");
bool rejected = false;
try { RegistryAlgorithms.Rasterize(0, 2, vertices, vertices, triangles, rgba, 2, 2, 0, 0); } catch (ArgumentException) { rejected = true; }
Check(rejected, "Invalid canvas is rejected");
rejected = false;
try { RegistryAlgorithms.Rasterize(2, 2, vertices, vertices, [0, 1], rgba, 2, 2, 0, 0); } catch (ArgumentException) { rejected = true; }
Check(rejected, "Invalid triangle list is rejected");
rejected = false;
try { RegistryAlgorithms.Rasterize(2, 2, vertices, vertices, triangles, [1], 2, 2, 0, 0); } catch (ArgumentException) { rejected = true; }
Check(rejected, "Inconsistent atlas crop is rejected");
Console.WriteLine($"{passed} runtime-algorithm checks PASS. Synthetic geometry/CSV tests; not a running Valheim or GPU integration test.");
