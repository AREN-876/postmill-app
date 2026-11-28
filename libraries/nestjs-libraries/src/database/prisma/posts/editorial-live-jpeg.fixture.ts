// Synthetic test data only. No runtime caller.
import sharp from 'sharp';
export function makeLiveJpegFixture() {
 return sharp({create:{width:1152,height:768,channels:3,background:'#123456'}}).jpeg().toBuffer();
}
