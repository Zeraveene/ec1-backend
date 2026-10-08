const encoder = new TextEncoder();
export const now = () => Math.floor(Date.now() / 1000);
export function base64(bytes: ArrayBuffer | Uint8Array | string): string {
  const data = typeof bytes === 'string' ? encoder.encode(bytes) : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...data)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
}
export function decode(value: string): Uint8Array<ArrayBuffer> { return Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')), c => c.charCodeAt(0)); }
export function random(): string { return base64(crypto.getRandomValues(new Uint8Array(32))); }
export async function hash(value: string): Promise<string> { return base64(await crypto.subtle.digest('SHA-256', encoder.encode(value))); }
export async function mac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return base64(await crypto.subtle.sign('HMAC',key,encoder.encode(value)));
}
export async function passwordHash(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
  return base64(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:decode(salt),iterations:100000},key,256));
}
export interface Claims { sub:string; sid:string; provider:string; scope:'player'|'migration'; deviceId:string|null; iss:string; aud:string; iat:number; exp:number }
export async function signToken(secret: string, value: Omit<Claims,'iss'|'aud'|'iat'|'exp'>): Promise<string> {
  const header=base64(JSON.stringify({alg:'HS256',typ:'JWT'}));
  const payload=base64(JSON.stringify({...value,iss:'ec1-backend',aud:'ec1-player',iat:now(),exp:now()+900}));
  return `${header}.${payload}.${await mac(secret,`${header}.${payload}`)}`;
}
export async function verifyToken(secret:string,token:string):Promise<Claims|null> {
  try {
    const parts=token.split('.'); if(parts.length!==3)return null;
    const [header,payload,signature]=parts;
    const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
    if(!await crypto.subtle.verify('HMAC',key,decode(signature),encoder.encode(`${header}.${payload}`)))return null;
    const h=JSON.parse(new TextDecoder().decode(decode(header))); const p=JSON.parse(new TextDecoder().decode(decode(payload))) as Claims;
    return h.alg==='HS256'&&h.typ==='JWT'&&p.iss==='ec1-backend'&&p.aud==='ec1-player'&&typeof p.sub==='string'&&typeof p.sid==='string'&&typeof p.provider==='string'&&(p.scope==='player'||p.scope==='migration')&&Number.isSafeInteger(p.exp)&&Number.isSafeInteger(p.iat)&&p.exp>now()&&p.iat<=now()+30 ? p:null;
  }catch{return null;}
}
