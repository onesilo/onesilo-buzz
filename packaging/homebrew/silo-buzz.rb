# Homebrew formula for silo-buzz.
#
# Staged in-repo rather than published: a bare `brew install silo-buzz`
# resolves against homebrew-core, which has notability requirements a new
# project does not meet. Moving this file to onesilo/homebrew-tap as
# Formula/silo-buzz.rb is the only step needed to make
#
#   brew tap onesilo/tap && brew install silo-buzz
#
# work; nothing in the formula itself changes.
#
# Until then it installs directly from the file:
#
#   brew install --build-from-source ./packaging/homebrew/silo-buzz.rb
#
# `url`/`sha256` point at an npm tarball because that is what `npm pack`
# publishes and what `npm install -g` consumes — keeping one artifact behind
# both install paths, rather than a Homebrew-only tarball that could differ
# from what npm users get.
class SiloBuzz < Formula
  desc "Long-term memory for your Buzz workspace, powered by One Silo"
  homepage "https://github.com/onesilo/onesilo-buzz"
  url "https://registry.npmjs.org/@onesilo/buzz-silo-memory/-/buzz-silo-memory-0.1.0.tgz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "Apache-2.0"

  # Matches the engines field in package.json. The agent uses fetch and
  # node:test features that landed in 22.
  depends_on "node" >= "22"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  # onesilo-node is deliberately NOT a dependency. Most of what the agent
  # does works without one, and whether to run a node is a privacy decision
  # the operator should make knowingly — `silo-buzz run` asks, and installs
  # it then. A hard dependency would make that choice silently on their
  # behalf at install time.

  def caveats
    <<~EOS
      Get started:
        silo-buzz run

      It will offer to install a onesilo-node so conversation is distilled on
      this machine. Without one, raw transcripts are sent to your silo for
      distillation.

      Pair with One Silo first if you have not:
        silo-buzz connect
    EOS
  end

  test do
    # Exercising `run` would need a relay and a paired account; the version
    # command is the part that is meaningful to assert offline — it proves
    # the bin symlink resolves and the package's own version lookup works.
    assert_match version.to_s, shell_output("#{bin}/silo-buzz --version")
    assert_match "silo-buzz run", shell_output("#{bin}/silo-buzz --help")
  end
end
