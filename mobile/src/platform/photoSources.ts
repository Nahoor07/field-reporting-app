import { PermissionsAndroid, Platform } from 'react-native';
import { launchCamera, launchImageLibrary, type ImagePickerResponse } from 'react-native-image-picker';

/**
 * Camera and gallery, reduced to outcomes the UI must design for.
 *
 * Gallery needs no permission on either platform: Android uses the system Photo Picker,
 * iOS uses PHPicker. Both run out-of-process and hand back only what the user chose.
 * Camera needs one, and "blocked" (denied with don't-ask-again) is a real, designed state.
 */
export type PickResult =
  | { kind: 'picked'; uris: string[] }
  | { kind: 'cancelled' }
  | { kind: 'denied' }
  | { kind: 'blocked' }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string };

export type CameraAccess = 'unknown' | 'granted' | 'denied' | 'blocked';

/** Quiet check, no prompt. Used on mount and when returning from Settings. */
export async function checkCameraAccess(previous: CameraAccess): Promise<CameraAccess> {
  if (Platform.OS !== 'android') return previous === 'blocked' ? 'unknown' : previous; // iOS: re-learn on next try
  const granted = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.CAMERA);
  if (granted) return 'granted';
  return previous === 'granted' ? 'unknown' : previous;
}

async function requestCameraAccess(): Promise<CameraAccess> {
  if (Platform.OS !== 'android') return 'unknown'; // the picker prompts on iOS
  const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA, {
    title: 'Camera for site photos',
    message: 'Field Reports uses the camera only when you tap “Take photo”.',
    buttonPositive: 'Continue',
  });
  if (result === PermissionsAndroid.RESULTS.GRANTED) return 'granted';
  if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) return 'blocked';
  return 'denied';
}

export async function takePhoto(): Promise<PickResult & { access?: CameraAccess }> {
  const access = await requestCameraAccess();
  if (access === 'blocked') return { kind: 'blocked', access };
  if (access === 'denied') return { kind: 'denied', access };
  const response = await launchCamera({ mediaType: 'photo', saveToPhotos: false, quality: 1 });
  return { ...toResult(response), access: Platform.OS === 'android' ? 'granted' : undefined };
}

export async function choosePhotos(limit: number): Promise<PickResult> {
  const response = await launchImageLibrary({ mediaType: 'photo', selectionLimit: limit, quality: 1 });
  return toResult(response);
}

function toResult(response: ImagePickerResponse): PickResult {
  if (response.didCancel) return { kind: 'cancelled' };
  if (response.errorCode === 'permission') return { kind: 'blocked' };
  if (response.errorCode === 'camera_unavailable') return { kind: 'unavailable' };
  if (response.errorCode) return { kind: 'error', message: response.errorMessage ?? 'Something went wrong' };
  const uris = (response.assets ?? []).map(asset => asset.uri).filter((uri): uri is string => Boolean(uri));
  return uris.length ? { kind: 'picked', uris } : { kind: 'cancelled' };
}
