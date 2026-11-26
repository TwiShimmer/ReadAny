Pod::Spec.new do |s|
  s.name = 'SyncFileTransfer'
  s.version = '0.1.0'
  s.summary = 'Native file transfers for ReadAny sync'
  s.license = 'GPL-3.0-or-later'
  s.author = 'ReadAny'
  s.homepage = 'https://github.com/codedogQBY/ReadAny'
  s.platforms = { :ios => '15.1' }
  s.swift_version = '5.9'
  s.source = { :path => '.' }
  s.static_framework = true
  s.source_files = '**/*.swift'
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
