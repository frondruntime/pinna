// Minimal Hermes host: runs one bytecode or source file with print, gc, and
// now (milliseconds from a steady clock, to the microsecond; Hermes has no
// `performance`), microtasks on, as React Native configures its runtime.
// Hermes V1 releases ship hermesc and the hermesvm framework but no hermes
// runner; this is one. The last argument is the file; the benches pass flags
// it ignores.
//
// R=<hermes-ios release>/destroot
// clang++ -std=c++20 -O2 -I$R/include -F$R/Library/Frameworks/macosx \
//   -framework hermesvm -Wl,-rpath,$R/Library/Frameworks/macosx \
//   bench/hermes-host.cpp -o $R/bin/hermes
#include <hermes/hermes.h>
#include <jsi/instrumentation.h>
#include <chrono>
#include <fstream>
#include <iostream>
#include <sstream>

using namespace facebook;

int main(int argc, char **argv) {
  if (argc < 2) return 2;
  std::ifstream file(argv[argc - 1], std::ios::binary);
  std::stringstream buffer;
  buffer << file.rdbuf();
  auto config = ::hermes::vm::RuntimeConfig::Builder().withMicrotaskQueue(true).build();
  auto runtime = facebook::hermes::makeHermesRuntime(config);
  jsi::Runtime &rt = *runtime;
  rt.global().setProperty(rt, "print", jsi::Function::createFromHostFunction(
    rt, jsi::PropNameID::forAscii(rt, "print"), 1,
    [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t count) {
      if (count > 0) std::cout << args[0].toString(rt).utf8(rt) << std::endl;
      return jsi::Value::undefined();
    }));
  rt.global().setProperty(rt, "gc", jsi::Function::createFromHostFunction(
    rt, jsi::PropNameID::forAscii(rt, "gc"), 0,
    [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *, size_t) {
      rt.instrumentation().collectGarbage("bench");
      return jsi::Value::undefined();
    }));
  rt.global().setProperty(rt, "now", jsi::Function::createFromHostFunction(
    rt, jsi::PropNameID::forAscii(rt, "now"), 0,
    [](jsi::Runtime &, const jsi::Value &, const jsi::Value *, size_t) {
      auto elapsed = std::chrono::steady_clock::now().time_since_epoch();
      return jsi::Value(std::chrono::duration<double, std::milli>(elapsed).count());
    }));
  try {
    rt.evaluateJavaScript(std::make_shared<jsi::StringBuffer>(buffer.str()), argv[argc - 1]);
    rt.drainMicrotasks();
  } catch (const jsi::JSError &error) {
    std::cerr << error.getMessage() << "\n" << error.getStack() << std::endl;
    return 1;
  }
  return 0;
}
