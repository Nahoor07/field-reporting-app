import React from 'react';
import { StyleSheet, View } from 'react-native';

type Name = 'camera' | 'image' | 'plus';

/**
 * A few line icons drawn with plain Views, so the app needs no icon font or SVG native module.
 * Every icon fits a 24×24 box.
 */
export function Icon({ name, color, size = 24 }: { name: Name; color: string; size?: number }) {
  const scale = size / 24;
  return (
    <View style={[styles.box, { transform: [{ scale }] }]} accessibilityElementsHidden importantForAccessibility="no">
      {name === 'camera' && (
        <>
          <View style={[styles.cameraBump, { backgroundColor: color }]} />
          <View style={[styles.cameraBody, { borderColor: color }]}>
            <View style={[styles.cameraLens, { borderColor: color }]} />
          </View>
        </>
      )}
      {name === 'image' && (
        <View style={[styles.frame, { borderColor: color }]}>
          <View style={[styles.sun, { backgroundColor: color }]} />
          <View style={[styles.hillBig, { backgroundColor: color }]} />
          <View style={[styles.hillSmall, { backgroundColor: color }]} />
        </View>
      )}
      {name === 'plus' && (
        <>
          <View style={[styles.plusH, { backgroundColor: color }]} />
          <View style={[styles.plusV, { backgroundColor: color }]} />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  cameraBump: { position: 'absolute', top: 3, left: 8, width: 8, height: 4, borderTopLeftRadius: 2, borderTopRightRadius: 2 },
  cameraBody: {
    marginTop: 3,
    width: 22,
    height: 15,
    borderWidth: 2,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraLens: { width: 8, height: 8, borderRadius: 4, borderWidth: 2 },
  frame: { width: 21, height: 18, borderWidth: 2, borderRadius: 4, overflow: 'hidden' },
  sun: { position: 'absolute', top: 2, right: 3, width: 4, height: 4, borderRadius: 2 },
  hillBig: { position: 'absolute', bottom: -7, left: 0, width: 11, height: 11, transform: [{ rotate: '45deg' }] },
  hillSmall: { position: 'absolute', bottom: -5, right: 1, width: 8, height: 8, transform: [{ rotate: '45deg' }] },
  plusH: { position: 'absolute', width: 14, height: 2.5, borderRadius: 2 },
  plusV: { position: 'absolute', width: 2.5, height: 14, borderRadius: 2 },
});
