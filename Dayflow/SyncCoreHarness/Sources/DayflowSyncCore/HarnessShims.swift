//
//  HarnessShims.swift — harness only (not part of the app).
//
//  swift-corelibs-foundation has no Combine. SyncCenter only needs `ObservableObject` and
//  `@Published` to compile, so Linux builds get inert stand-ins.
//

#if !canImport(Combine)
  protocol ObservableObject: AnyObject {}

  @propertyWrapper
  struct Published<Value> {
    var wrappedValue: Value
    init(wrappedValue: Value) { self.wrappedValue = wrappedValue }
  }
#endif
