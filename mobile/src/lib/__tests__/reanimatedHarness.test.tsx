/**
 * Harness test for react-native-reanimated under jest.
 *
 * Why this file exists: reanimated 4.5.1 + react-native-worklets 0.10.1 crash at
 * IMPORT time under jest unless `jest.config.js` sets
 * `resolver: 'react-native-worklets/jest/resolver'`. Because the throw happens in
 * a node_modules import, before any test body runs, it cannot be caught, mocked
 * around, or fixed by reanimated's own `setUpTests()`. Every other test in this
 * repo passed while the harness was broken, because nothing else imported
 * reanimated -- a green suite was not evidence the harness worked.
 *
 * So this file is the regression test for the harness itself: if the resolver is
 * dropped, this suite fails to *run*, which is the correct and only possible
 * signal for an import-time crash.
 *
 * The second thing this file guards is subtler and much more likely to bite.
 * `props.style` is frozen at the initial value forever; only `getAnimatedStyle`
 * sees the animation. Asserting `el.props.style` passes even when time has not
 * advanced at all, so an animated test written that way is a false pass. The
 * last test in this file pins that fact down explicitly so nobody "simplifies"
 * the assertions back onto `props.style`.
 */

import { act, render } from '@testing-library/react-native';
import React, { useEffect } from 'react';
import Animated, {
  getAnimatedStyle,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

const TEST_ID = 'harness-box';

/** Reads the live animated value off a rendered element. */
function translateXOf(element: { props: Record<string, unknown> }): number {
  const style = getAnimatedStyle(element) as {
    transform?: Array<{ translateX?: number }>;
  };
  return style.transform?.[0]?.translateX ?? Number.NaN;
}

function Box() {
  const offset = useSharedValue(0);
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: offset.value }] }));

  return <Animated.View testID={TEST_ID} style={style} />;
}

function LoopingBox() {
  const offset = useSharedValue(0);
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: offset.value }] }));

  useEffect(() => {
    // Linear easing on purpose: withTiming's default easing is inOut(ease), which
    // is not linear, so the mid-point value would not be assertable exactly.
    offset.value = withRepeat(
      withTiming(100, { duration: 1000, easing: (t) => t }),
      -1,
      false
    );
  }, [offset]);

  return <Animated.View testID={TEST_ID} style={style} />;
}

describe('reanimated jest harness', () => {
  beforeEach(() => {
    // Before the first `render`, not after: the animation loop schedules its
    // first frame through requestAnimationFrame, which jest's modern fake timers
    // replace. Installing them post-render would leave the loop on real rAF and
    // `advanceTimersByTime` would move nothing.
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders a component built on useSharedValue + useAnimatedStyle', async () => {
    const { getByTestId } = await render(<Box />);
    const element = getByTestId(TEST_ID);

    expect(element).toBeTruthy();
    expect(translateXOf(element)).toBe(0);
    // Also exercises the custom matcher registered by setUpTests() in
    // jest.setup.js -- if that registration ever regresses, this is undefined
    // and throws rather than silently passing.
    expect(element).toHaveAnimatedStyle({ transform: [{ translateX: 0 }] });
  });

  it('reflects a direct shared-value mutation in the animated style', async () => {
    function MutatingBox() {
      const offset = useSharedValue(0);
      const style = useAnimatedStyle(() => ({ transform: [{ translateX: offset.value }] }));

      useEffect(() => {
        offset.value = 42;
      }, [offset]);

      return <Animated.View testID={TEST_ID} style={style} />;
    }

    const { getByTestId } = await render(<MutatingBox />);
    const element = getByTestId(TEST_ID);

    // A direct write outside the animation loop still has to travel through
    // useAnimatedStyle's mapper before it lands in jestAnimatedStyle, so it needs
    // one frame to flush -- which is itself a second proof the frame loop is live.
    expect(translateXOf(element)).toBe(0);

    await act(async () => {
      jest.advanceTimersByTime(16);
    });
    expect(translateXOf(element)).toBe(42);
  });

  it('advances a withTiming animation as timers move forward', async () => {
    const { getByTestId } = await render(<LoopingBox />);
    const element = getByTestId(TEST_ID);

    expect(translateXOf(element)).toBe(0);

    await act(async () => {
      jest.advanceTimersByTime(250);
    });
    expect(translateXOf(element)).toBe(25);
    expect(element).toHaveAnimatedStyle({ transform: [{ translateX: 25 }] });

    await act(async () => {
      jest.advanceTimersByTime(250);
    });
    // Halfway through a 1000ms linear timing. If the harness were not driving
    // real time, this would still read 0 and the test above would have been the
    // only thing passing.
    expect(translateXOf(element)).toBe(50);

    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    expect(translateXOf(element)).toBe(100);
  });

  it('keeps moving through a withRepeat cycle instead of jumping once', async () => {
    const { getByTestId } = await render(<LoopingBox />);
    const element = getByTestId(TEST_ID);

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(translateXOf(element)).toBe(100);

    // The repeat wraps back to the start, so 500ms later we are mid-second-pass
    // and DESCENDING. A single non-looping jump to 100 would leave this at 100.
    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    expect(translateXOf(element)).toBe(50);
  });

  it('leaves props.style frozen at the initial value (the false-pass trap)', async () => {
    const { getByTestId } = await render(<LoopingBox />);
    const element = getByTestId(TEST_ID);
    const propsStyleOf = () => {
      const style = element.props.style as Array<{
        transform?: Array<{ translateX?: number }>;
      }>;
      return style[0]?.transform?.[0]?.translateX ?? Number.NaN;
    };

    expect(propsStyleOf()).toBe(0);

    await act(async () => {
      jest.advanceTimersByTime(500);
    });

    // Time HAS advanced -- proven by the live read:
    expect(translateXOf(element)).toBe(50);
    // ...while the prop a naive assertion would target is still 0. This is why
    // the tests above assert through getAnimatedStyle and never through props.style.
    expect(propsStyleOf()).toBe(0);
  });
});
