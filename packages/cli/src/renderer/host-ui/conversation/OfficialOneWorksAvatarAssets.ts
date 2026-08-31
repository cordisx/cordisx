import { parseAvatarDefinition, type AvatarDefinition } from '@oneworks/avatar'

/**
 * Exact definitions captured from the public OneWorks Avatar breed editor.
 *
 * The editor is the authoring source; these are canonical serializations of
 * immutable editor outputs, not Host-generated defaults. `capturedExportSha256`
 * identifies the original editor export bytes; `canonicalDefinitionSha256`
 * identifies the complete JSON payload actually parsed below. The opaque keys
 * are resolved only by the Host so plugins never select palette, preset,
 * camera, or scale parameters.
 */
export const HOST_ONEWORKS_RED_FOX_AVATAR_ASSET_REF = 'oneworks-avatar:asset.red-fox.v1' as const
export const HOST_ONEWORKS_ARCTIC_FOX_AVATAR_ASSET_REF = 'oneworks-avatar:asset.arctic-fox.v1' as const
export const HOST_ONEWORKS_RED_FOX_AVATAR_ASSET_REVISION = 'oneworks-avatar:editor-red-fox-2b30c25a3fcd29bf349fed927df85f1ba4b0a6096a9dfc1d2d1088e05654d8aa' as const
export const HOST_ONEWORKS_ARCTIC_FOX_AVATAR_ASSET_REVISION = 'oneworks-avatar:editor-arctic-fox-2c262adc567c423a94d497bfea9c9906f2da71cdde0e0cef6d71c263ceaf3011' as const

export const OFFICIAL_ONEWORKS_AVATAR_ASSET_PROVENANCE = Object.freeze({
  source: 'https://oneworks.cloud/avatar/',
  renderer: '@oneworks/avatar-react@1.0.0-rc.8',
  definitions: Object.freeze({
    [HOST_ONEWORKS_RED_FOX_AVATAR_ASSET_REF]: Object.freeze({
      profileId: 'red-fox',
      capturedExportSha256: '2b30c25a3fcd29bf349fed927df85f1ba4b0a6096a9dfc1d2d1088e05654d8aa',
      canonicalDefinitionSha256: 'e4df5d748767718eeed6cdc77b3ab0cbe10441adf3cf713d3a9e126c3527d0d9',
    }),
    [HOST_ONEWORKS_ARCTIC_FOX_AVATAR_ASSET_REF]: Object.freeze({
      profileId: 'arctic-fox',
      capturedExportSha256: '2c262adc567c423a94d497bfea9c9906f2da71cdde0e0cef6d71c263ceaf3011',
      canonicalDefinitionSha256: '6a178492316eac13e7198581f4657bc8bd0d2259871eff762a022f4cc1594ab0',
    }),
  }),
})

const RED_FOX_EDITOR_EXPORT = `{"metadata":{"generation":{"fields":[],"profileId":"red-fox","seed":"v1-0eq0qyf17iiefk1nv3ixk","version":1}},"scene":{"appearance":{"backgroundStyle":"solid","bodyShape":"sphere","paletteId":"red-fox"},"camera":{"background":"#173d35","frame":"rounded","frameShadow":{"direction":90,"distance":12,"opacity":22,"softness":24},"showFrameShadow":true,"size":256},"effects":{"avatarShadow":{"color":"#000000","direction":45,"distance":12,"opacity":24,"softness":16},"colorGrade":{"brightness":1,"saturation":1,"tintAmount":0,"tintB":0,"tintG":0,"tintR":0},"faceShadow":{"direction":50,"distance":4,"opacity":28,"softness":0},"outline":{"color":"#ffffff","opacity":80,"width":4},"showAvatarShadow":false,"showFaceShadow":false,"showOutline":true},"decals":[{"color":"#ffffeb","height":108,"id":"fox-inner-ear-left","label":"Left inner ear","opacity":100,"rotation":180,"shape":"rounded-triangle","side":"front","targetPartId":"fox-ear-left","width":76,"x":0,"y":-8},{"color":"#ffffeb","height":108,"id":"fox-inner-ear-right","label":"Right inner ear","opacity":100,"rotation":180,"shape":"rounded-triangle","side":"front","targetPartId":"fox-ear-right","width":76,"x":0,"y":-8},{"color":"#fffff8","height":132,"id":"fox-cheek-left","label":"Left cheek","opacity":100,"rotation":-76,"shape":"rounded-triangle","side":"face","targetPartId":"fox-head","width":128,"x":-57,"y":27},{"color":"#fffff8","height":132,"id":"fox-cheek-right","label":"Right cheek","opacity":100,"rotation":76,"shape":"rounded-triangle","side":"face","targetPartId":"fox-head","width":128,"x":57,"y":27}],"entity":{"parts":[{"baseColor":"#e66b3d","foregroundColor":"#26352b","highlightColor":"#ff8a59","shadowColor":"#853c22","face":false,"id":"fox-ear-left","label":"Left ear","occludedByFace":true,"occlusionAmount":10,"occlusionPole":"bottom","rotationX":-5,"rotationY":-11,"rotationZ":-13,"roundness":28,"scaleX":0.32549999999999996,"scaleY":0.47,"scaleZ":0.24,"shape":"cone","x":-71.4,"y":-81,"z":-16},{"baseColor":"#e66b3d","foregroundColor":"#26352b","highlightColor":"#ff8a59","shadowColor":"#853c22","face":false,"id":"fox-ear-right","label":"Right ear","occludedByFace":true,"occlusionAmount":10,"occlusionPole":"bottom","rotationX":-5,"rotationY":11,"rotationZ":13,"roundness":28,"scaleX":0.32549999999999996,"scaleY":0.47,"scaleZ":0.24,"shape":"cone","x":71.4,"y":-81,"z":-16},{"baseColor":"#fe8851","foregroundColor":"#26352b","highlightColor":"#ffaa71","shadowColor":"#a74d2a","bottomTaper":52,"face":true,"id":"fox-head","label":"Head","roundness":76,"scaleX":0.882,"scaleY":0.7,"scaleZ":0.7,"shape":"ellipse","x":0,"y":17,"z":0}],"preset":"fox"},"face":{"eyeHighlight":{"color":"#ffffff","enabled":false,"offsetX":-18,"offsetY":-20,"opacity":92,"size":24},"eyeRoundness":100,"eyeShape":"rounded","gap":54,"height":37,"leftEyeRotation":-8,"mouthCurve":45,"mouthEnabled":false,"mouthHeight":12,"mouthRotation":0,"mouthShape":"curve","mouthWidth":52,"mouthY":52,"noseEnabled":true,"noseHeight":17,"noseRotation":0,"noseShape":"inverted-triangle","noseWidth":24,"noseY":39,"rotation":0,"rightEyeRotation":8,"width":21},"interactionMode":"rotate","lighting":{"azimuth":-35,"distance":0,"elevation":40,"enabled":false,"gridDensity":100},"view":{"pitch":-0.2928,"positionX":-83.4663,"positionY":95.6374,"roll":0.424,"scale":1.7697,"yaw":0.2109}},"schema":"oneworks.avatar","version":1}`

const ARCTIC_FOX_EDITOR_EXPORT = `{"metadata":{"generation":{"fields":[],"profileId":"arctic-fox","seed":"v1-1cvw64n1bvbrnx12tey1f","version":1}},"scene":{"appearance":{"backgroundStyle":"solid","bodyShape":"sphere","paletteId":"arctic-fox"},"camera":{"background":"#173d35","frame":"rounded","frameShadow":{"direction":90,"distance":12,"opacity":22,"softness":24},"showFrameShadow":true,"size":256},"effects":{"avatarShadow":{"color":"#000000","direction":45,"distance":12,"opacity":24,"softness":16},"colorGrade":{"brightness":1,"saturation":1,"tintAmount":0,"tintB":0,"tintG":0,"tintR":0},"faceShadow":{"direction":50,"distance":4,"opacity":28,"softness":0},"outline":{"color":"#ffffff","opacity":80,"width":4},"showAvatarShadow":false,"showFaceShadow":false,"showOutline":true},"decals":[{"color":"#d7b5ad","height":89,"id":"fox-inner-ear-left","label":"Left inner ear","opacity":100,"rotation":180,"shape":"rounded-triangle","side":"front","targetPartId":"fox-ear-left","width":62,"x":0,"y":-8},{"color":"#d7b5ad","height":89,"id":"fox-inner-ear-right","label":"Right inner ear","opacity":100,"rotation":180,"shape":"rounded-triangle","side":"front","targetPartId":"fox-ear-right","width":62,"x":0,"y":-8},{"color":"#faf8f2","height":144,"id":"fox-cheek-left","label":"Left cheek","opacity":100,"rotation":-76,"shape":"rounded-triangle","side":"face","targetPartId":"fox-head","width":140,"x":-57,"y":27},{"color":"#faf8f2","height":144,"id":"fox-cheek-right","label":"Right cheek","opacity":100,"rotation":76,"shape":"rounded-triangle","side":"face","targetPartId":"fox-head","width":140,"x":57,"y":27}],"entity":{"parts":[{"baseColor":"#cfd4d2","foregroundColor":"#38454c","highlightColor":"#eeede9","shadowColor":"#a2adb0","face":false,"id":"fox-ear-left","label":"Left ear","occludedByFace":true,"occlusionAmount":10,"occlusionPole":"bottom","rotationX":-5,"rotationY":-11,"rotationZ":-9,"roundness":78,"scaleX":0.23870000000000002,"scaleY":0.41359999999999997,"scaleZ":0.24,"shape":"cone","x":-67.58,"y":-63.99000000000001,"z":-14},{"baseColor":"#cfd4d2","foregroundColor":"#38454c","highlightColor":"#eeede9","shadowColor":"#a2adb0","face":false,"id":"fox-ear-right","label":"Right ear","occludedByFace":true,"occlusionAmount":10,"occlusionPole":"bottom","rotationX":-5,"rotationY":11,"rotationZ":9,"roundness":78,"scaleX":0.23870000000000002,"scaleY":0.41359999999999997,"scaleZ":0.24,"shape":"cone","x":67.58,"y":-63.99000000000001,"z":-14},{"baseColor":"#d4d8d3","foregroundColor":"#38454c","highlightColor":"#f5f3ee","shadowColor":"#a6b1b5","bottomTaper":23,"face":true,"id":"fox-head","label":"Head","roundness":76,"scaleX":0.9156000000000001,"scaleY":0.637,"scaleZ":0.7,"shape":"ellipse","x":0,"y":17,"z":0}],"preset":"fox"},"face":{"eyeHighlight":{"color":"#ffffff","enabled":false,"offsetX":-18,"offsetY":-20,"opacity":92,"size":24},"eyeRoundness":100,"eyeShape":"rounded","gap":43,"height":50,"leftEyeRotation":-8,"mouthCurve":45,"mouthEnabled":false,"mouthHeight":12,"mouthRotation":0,"mouthShape":"curve","mouthWidth":52,"mouthY":52,"noseEnabled":true,"noseHeight":17,"noseRotation":0,"noseShape":"inverted-triangle","noseWidth":13,"noseY":39,"rotation":0,"rightEyeRotation":8,"width":24},"interactionMode":"rotate","lighting":{"azimuth":-35,"distance":0,"elevation":40,"enabled":false,"gridDensity":100},"view":{"pitch":-0.2928,"positionX":-83.4663,"positionY":95.6374,"roll":0.424,"scale":1.7697,"yaw":0.2109}},"schema":"oneworks.avatar","version":1}`

const OFFICIAL_ONEWORKS_AVATAR_EDITOR_EXPORTS = new Map<string, string>([
  [HOST_ONEWORKS_RED_FOX_AVATAR_ASSET_REF, RED_FOX_EDITOR_EXPORT],
  [HOST_ONEWORKS_ARCTIC_FOX_AVATAR_ASSET_REF, ARCTIC_FOX_EDITOR_EXPORT],
])

export function resolveOfficialOneWorksAvatarAsset(ref: string, revision: string | undefined): AvatarDefinition | undefined {
  const expectedRevision = ref === HOST_ONEWORKS_RED_FOX_AVATAR_ASSET_REF
    ? HOST_ONEWORKS_RED_FOX_AVATAR_ASSET_REVISION
    : ref === HOST_ONEWORKS_ARCTIC_FOX_AVATAR_ASSET_REF
      ? HOST_ONEWORKS_ARCTIC_FOX_AVATAR_ASSET_REVISION
      : undefined
  const serialized = expectedRevision === revision ? OFFICIAL_ONEWORKS_AVATAR_EDITOR_EXPORTS.get(ref) : undefined
  return serialized === undefined ? undefined : parseAvatarDefinition(JSON.parse(serialized))
}
