import AppKit
import CoreGraphics
import Foundation

// UpSync uygulama ikonu.
//
// Sanat bilerek KENARDAN KENARA çiziliyor; yuvarlatılmış kareyi biz
// çizmiyoruz. macOS 26 eski usul .icns ikonlarını kendi standart karesine
// oturtuyor: kendi squircle'ımızı çizersek sistem onu bir gri çerçevenin
// içine koyuyor ve çift çerçeve oluşuyor. Tam kanamalı verince sistem
// maskeyi ve kenar derinliğini kendisi uyguluyor.
//
// Bedeli: macOS 15 ve öncesinde ikon köşeleri yuvarlatılmadan, düz kare
// görünür. Kalıcı çözüm Icon Composer (.icon) varlığı eklemek.

let variant = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "a"
let outPath = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "icon.png"
let size = CommandLine.arguments.count > 3 ? Int(CommandLine.arguments[3])! : 1024

/// Sürekli köşeli (squircle) yol - dairesel köşeye göre Apple'ın şekline yakın.
func squircle(in rect: CGRect, radius r: CGFloat) -> CGPath {
  let p = CGMutablePath()
  let k: CGFloat = 0.55  // süreklilik için kontrol noktası oranı
  let (x, y, w, h) = (rect.minX, rect.minY, rect.width, rect.height)

  p.move(to: CGPoint(x: x + r, y: y))
  p.addLine(to: CGPoint(x: x + w - r, y: y))
  p.addCurve(to: CGPoint(x: x + w, y: y + r),
             control1: CGPoint(x: x + w - r * k, y: y),
             control2: CGPoint(x: x + w, y: y + r * k))
  p.addLine(to: CGPoint(x: x + w, y: y + h - r))
  p.addCurve(to: CGPoint(x: x + w - r, y: y + h),
             control1: CGPoint(x: x + w, y: y + h - r * k),
             control2: CGPoint(x: x + w - r * k, y: y + h))
  p.addLine(to: CGPoint(x: x + r, y: y + h))
  p.addCurve(to: CGPoint(x: x, y: y + h - r),
             control1: CGPoint(x: x + r * k, y: y + h),
             control2: CGPoint(x: x, y: y + h - r * k))
  p.addLine(to: CGPoint(x: x, y: y + r))
  p.addCurve(to: CGPoint(x: x + r, y: y),
             control1: CGPoint(x: x, y: y + r * k),
             control2: CGPoint(x: x + r * k, y: y))
  p.closeSubpath()
  return p
}

func rgb(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat) -> CGColor {
  CGColor(red: r / 255, green: g / 255, blue: b / 255, alpha: 1)
}

struct Palette {
  let top: CGColor
  let bottom: CGColor
  let glyph: CGColor
  let tray: CGColor
}

// Sistem mavisi degrade, beyaz ok - uygulamanın vurgu rengiyle aynı dil.
let pal = Palette(top: rgb(88, 158, 255), bottom: rgb(24, 84, 214),
                  glyph: .white, tray: CGColor(gray: 1, alpha: 0.78))
_ = variant

let scale = CGFloat(size) / 1024.0
let cs = CGColorSpaceCreateDeviceRGB()
guard let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
                          bytesPerRow: 0, space: cs,
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
  exit(1)
}
ctx.scaleBy(x: scale, y: scale)
ctx.setShouldAntialias(true)
ctx.interpolationQuality = .high

// --- Gövde ---------------------------------------------------------------
// Apple ızgarası: 824x824, dikeyde 100 üst / 100 alt boşluk.
let body = CGRect(x: 0, y: 0, width: 1024, height: 1024)
let path = CGPath(rect: body, transform: nil)

ctx.saveGState()
ctx.addPath(path)
ctx.clip()
let grad = CGGradient(colorsSpace: cs,
                      colors: [pal.top, pal.bottom] as CFArray,
                      locations: [0, 1])!
ctx.drawLinearGradient(grad,
                       start: CGPoint(x: 512, y: 1024),
                       end: CGPoint(x: 512, y: 0),
                       options: [])

// Üstte hafif parlaklık: düz degradeye derinlik katar.
let sheen = CGGradient(colorsSpace: cs,
                       colors: [CGColor(gray: 1, alpha: 0.22),
                                CGColor(gray: 1, alpha: 0)] as CFArray,
                       locations: [0, 1])!
ctx.drawLinearGradient(sheen,
                       start: CGPoint(x: 512, y: 1024),
                       end: CGPoint(x: 512, y: 600),
                       options: [])
ctx.restoreGState()

// İnce iç kenar - kenarları keskinleştirir.


// --- Ok ------------------------------------------------------------------
// Yukarı ok: gövde + baş. Kalın tutuldu ki 16px'te de okunsun.
let cx: CGFloat = 512
let shaftW: CGFloat = 108
let shaftBottom: CGFloat = 360
let shaftTop: CGFloat = 640
let headW: CGFloat = 300
let headTop: CGFloat = 800

let arrow = CGMutablePath()
arrow.move(to: CGPoint(x: cx, y: headTop))
arrow.addLine(to: CGPoint(x: cx - headW / 2, y: shaftTop))
arrow.addLine(to: CGPoint(x: cx - shaftW / 2, y: shaftTop))
arrow.addLine(to: CGPoint(x: cx - shaftW / 2, y: shaftBottom))
arrow.addLine(to: CGPoint(x: cx + shaftW / 2, y: shaftBottom))
arrow.addLine(to: CGPoint(x: cx + shaftW / 2, y: shaftTop))
arrow.addLine(to: CGPoint(x: cx + headW / 2, y: shaftTop))
arrow.closeSubpath()

ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -8), blur: 22,
              color: CGColor(gray: 0, alpha: 0.28))
ctx.addPath(arrow)
ctx.setFillColor(pal.glyph)
ctx.fillPath()
ctx.restoreGState()

// --- Tepsi ---------------------------------------------------------------
// Okun çıktığı yer: hedefi (uzak sunucu) ima eder, menü çubuğundaki
// arrow.up.bin ile aynı fikir.
let trayY: CGFloat = 265
let trayW: CGFloat = 420
let tray = CGMutablePath()
tray.move(to: CGPoint(x: cx - trayW / 2, y: trayY + 96))
tray.addLine(to: CGPoint(x: cx - trayW / 2, y: trayY))
tray.addLine(to: CGPoint(x: cx + trayW / 2, y: trayY))
tray.addLine(to: CGPoint(x: cx + trayW / 2, y: trayY + 96))

ctx.saveGState()
ctx.addPath(tray)
ctx.setStrokeColor(pal.tray)
ctx.setLineWidth(52)
ctx.setLineCap(.round)
ctx.setLineJoin(.round)
ctx.strokePath()
ctx.restoreGState()

// --- Yaz -----------------------------------------------------------------
guard let image = ctx.makeImage() else { exit(1) }
let url = URL(fileURLWithPath: outPath)
guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
  exit(1)
}
CGImageDestinationAddImage(dest, image, nil)
CGImageDestinationFinalize(dest)
