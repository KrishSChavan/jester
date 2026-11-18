/**
 * jester-location: this Mac's position from Location Services, asked from inside Jester's own process.
 *
 * Electron's navigator.geolocation waits for macOS to allow it but never asks (Chrome asks from a part of Chromium
 * that Electron leaves out), so macOS never put its question to the user and every position timed out. Loaded into
 * Jester's main process (src/main/mac-location.js), this asks as Jester: macOS's question names him, and the answer
 * is kept under his bundle ID. Then it reads positions from Core Location itself.
 *
 * A Node-API module, built by scripts/build-location.mjs with the Xcode command line tools. The few Node-API
 * declarations it needs are written out below, so it needs no headers; the functions themselves come from the
 * process it's loaded into.
 *
 *   status()  'not-determined' | 'allowed' | 'denied' | 'restricted' | 'off' (Location Services off for the Mac)
 *   ask()     macOS's question, if it's never been answered
 *   locate()  asks Core Location for one position; returns the request's number
 *   latest()  the last answer, {request, lat, lon, accuracy, at} or {request, error, code}; null before any
 *
 * Everything runs on the main thread, whose run loop delivers Core Location's answers.
 */

#import <CoreLocation/CoreLocation.h>
#import <Foundation/Foundation.h>
#include <stddef.h>
#include <stdint.h>

typedef struct napi_env__ *napi_env;
typedef struct napi_value__ *napi_value;
typedef struct napi_callback_info__ *napi_callback_info;
typedef int napi_status;
typedef napi_value (*napi_callback)(napi_env env, napi_callback_info info);

extern napi_status napi_create_function(napi_env env, const char *name, size_t length, napi_callback cb, void *data, napi_value *result);
extern napi_status napi_create_object(napi_env env, napi_value *result);
extern napi_status napi_set_named_property(napi_env env, napi_value object, const char *name, napi_value value);
extern napi_status napi_create_string_utf8(napi_env env, const char *text, size_t length, napi_value *result);
extern napi_status napi_create_double(napi_env env, double value, napi_value *result);
extern napi_status napi_get_null(napi_env env, napi_value *result);

#define WHOLE ((size_t)-1)

@interface JesterLocation : NSObject <CLLocationManagerDelegate>
@end

static CLLocationManager *manager;
static JesterLocation *listener;
/** The last locate()'s number, and the number of the request the last answer was for (0: none yet). */
static double requested = 0;
static double answered = 0;
static CLLocation *fix;
static NSInteger failure = 0;
static NSString *failureText;

@implementation JesterLocation
- (void)locationManager:(CLLocationManager *)from didUpdateLocations:(NSArray<CLLocation *> *)locations {
  CLLocation *last = locations.lastObject;
  if (!last || requested == 0) return;
  fix = last;
  failureText = nil;
  answered = requested;
}

- (void)locationManager:(CLLocationManager *)from didFailWithError:(NSError *)error {
  if (requested == 0) return;
  fix = nil;
  failure = error.code;
  failureText = error.localizedDescription ?: @"no position";
  answered = requested;
}

// Asked for, or Core Location complains; the status itself is read when it's wanted.
- (void)locationManagerDidChangeAuthorization:(CLLocationManager *)from {
}
@end

static void ready(void) {
  if (manager) return;
  manager = [[CLLocationManager alloc] init];
  listener = [JesterLocation new];
  manager.delegate = listener;
  // Wi-Fi positioning gives tens of metres on a Mac: enough for the street.
  manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters;
}

static const char *statusName(void) {
  ready();
  switch (manager.authorizationStatus) {
    case kCLAuthorizationStatusAuthorizedAlways:
      return "allowed";
    case kCLAuthorizationStatusRestricted:
      return "restricted";
    case kCLAuthorizationStatusNotDetermined:
      // With Location Services off for the whole Mac, macOS has nothing to ask.
      return [CLLocationManager locationServicesEnabled] ? "not-determined" : "off";
    case kCLAuthorizationStatusDenied:
      return [CLLocationManager locationServicesEnabled] ? "denied" : "off";
    default:
      return "allowed";
  }
}

static napi_value text(napi_env env, const char *value) {
  napi_value result;
  napi_create_string_utf8(env, value, WHOLE, &result);
  return result;
}

static napi_value number(napi_env env, double value) {
  napi_value result;
  napi_create_double(env, value, &result);
  return result;
}

static napi_value Status(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    return text(env, statusName());
  }
}

static napi_value Ask(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    ready();
    if (manager.authorizationStatus == kCLAuthorizationStatusNotDetermined) [manager requestWhenInUseAuthorization];
    return text(env, statusName());
  }
}

static napi_value Locate(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    ready();
    requested += 1;
    [manager requestLocation];
    return number(env, requested);
  }
}

static napi_value Latest(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    napi_value result;
    if (answered == 0) {
      napi_get_null(env, &result);
      return result;
    }
    napi_create_object(env, &result);
    napi_set_named_property(env, result, "request", number(env, answered));
    if (fix) {
      napi_set_named_property(env, result, "lat", number(env, fix.coordinate.latitude));
      napi_set_named_property(env, result, "lon", number(env, fix.coordinate.longitude));
      napi_set_named_property(env, result, "accuracy", number(env, fix.horizontalAccuracy));
      napi_set_named_property(env, result, "at", number(env, fix.timestamp.timeIntervalSince1970 * 1000));
    } else {
      napi_set_named_property(env, result, "error", text(env, failureText.UTF8String ?: "no position"));
      napi_set_named_property(env, result, "code", number(env, (double)failure));
    }
    return result;
  }
}

static void expose(napi_env env, napi_value exports, const char *name, napi_callback cb) {
  napi_value fn;
  napi_create_function(env, name, WHOLE, cb, NULL, &fn);
  napi_set_named_property(env, exports, name, fn);
}

__attribute__((visibility("default"))) int32_t node_api_module_get_api_version_v1(void) {
  return 8;
}

__attribute__((visibility("default"))) napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  expose(env, exports, "status", Status);
  expose(env, exports, "ask", Ask);
  expose(env, exports, "locate", Locate);
  expose(env, exports, "latest", Latest);
  return exports;
}
