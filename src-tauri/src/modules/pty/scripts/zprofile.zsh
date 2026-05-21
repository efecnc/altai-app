# altai-shell-integration (zprofile)
#
# See zshenv.zsh for the rationale on the trailing `:`.
{
  _altai_user_zdotdir="${ALTAI_USER_ZDOTDIR:-$HOME}"
  [ -f "$_altai_user_zdotdir/.zprofile" ] && source "$_altai_user_zdotdir/.zprofile"
  unset _altai_user_zdotdir
}
:
