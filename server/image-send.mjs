import {fail} from './errors.mjs';
import {imageResult} from './media.mjs';

// 10 MiB stays inside the private worker pipe after base64 (see WORKER_LINE_MAX).
export const IMAGE_SEND_MAX_BYTES=10*1024*1024;
export const IMAGE_SEND_BODY_LIMIT='15mb';
// One JSON line on the private worker pipe; was 2,000,000 before image sends.
export const WORKER_LINE_MAX=16_000_000;
export const IMAGE_TRANSPORT_NOTICE='This image is transport-encrypted by LINE, not Letter Sealed (OpenChat or Official Account recipient).';
const LIMITS={maxBytes:IMAGE_SEND_MAX_BYTES,maxSide:16384,maxPixels:120_000_000,jpegTrailer:true};

// Only raster PNG/JPEG bytes are uploaded. Caller filenames and MIME labels are
// never trusted or forwarded; the name is derived. Bytes are sent unmodified,
// so embedded metadata (for example EXIF GPS) is NOT stripped.
export function validateImageSend(input){
  if(!input||typeof input!=='object'||Array.isArray(input))fail(400,'invalid_image','Supply data (base64 PNG/JPEG).');
  const extra=Object.keys(input).filter(k=>!['data','acknowledgeTransportSecurity'].includes(k));
  if(extra.length)fail(400,'invalid_image',`Unsupported image field: ${extra[0]}.`);
  if(input.acknowledgeTransportSecurity!==undefined&&input.acknowledgeTransportSecurity!==true)fail(400,'invalid_image','acknowledgeTransportSecurity may only be true.');
  const data=input.data;
  if(typeof data!=='string'||!data.length||data.length>Math.ceil(IMAGE_SEND_MAX_BYTES/3)*4+4||!/^[A-Za-z0-9+/]+={0,2}$/.test(data)||data.length%4!==0)fail(400,'invalid_image','Image data must be standard base64 without whitespace.');
  const bytes=Buffer.from(data,'base64');
  const {mimeType,width,height,sha256}=imageResult(bytes,false,LIMITS);
  return {data,mimeType,width,height,bytes:bytes.length,sha256,filename:mimeType==='image/png'?'image.png':'image.jpg',...(input.acknowledgeTransportSecurity===true?{acknowledgeTransportSecurity:true}:{})};
}
export function imageBlob(image){return new Blob([Buffer.from(image.data,'base64')],{type:image.mimeType});}
